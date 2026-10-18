/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and a preview/edit toggle for markdown files. Registered as the
 * `code` (catch-all) and `markdown` built-in viewers; the editor tab host
 * fetches the content through the fsRead strategy and passes it in props,
 * so this component never fetches or dispatches — it only edits.
 *
 * The toolbar (mode toggle / dirty dot / save / status) renders as its own
 * row below the host's title bar, VSCode-style — unless the host passes
 * `toolbar: 'host'` (the merged editor-explorer mode), in which case this
 * component skips the row and reports state + registers commands through
 * the FileViewerProps toolbar callbacks so the host's path-input header
 * renders the controls instead.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState, StateEffect, StateField, Transaction, type Range } from '@codemirror/state'
import { Decoration, EditorView as CodeMirrorView, keymap, lineNumbers, WidgetType, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { IconCheckOutlineRegular, IconSearchOutlineRegular, MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import {
  applyGitLineKinds,
  CmGitGutterCompartment,
  useEditorGitGutter,
  type GitGutterHost,
} from './editor-git-gutter.ts'
import { api, htmlUrl, SidebarApiError } from './api.ts'
import { hostTransportBase } from './desktop-env.ts'
import { markdownPreviewSource } from './markdown-frontmatter.ts'
import { rewriteLocalImageUrls } from './markdown-images.ts'
import { rewriteLocalMarkdownLinks } from './markdown-navigation.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { cmSearchExtensions, CmSearchPhrases } from './cm-search.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { insertSelectionReference } from './conversation-draft.ts'
import { useSelectionPopup } from './selection-popup.ts'
import { linesOfSelection } from './selection-payload.ts'
import type { SelectionReference } from './selection-reference.ts'
import { writeSelectionDrag } from './cursorlike-interactions.ts'
import {
  activeHunkOf,
  buildPendingReview,
  keepAllReviewHunks,
  keepReviewHunk,
  nextPending,
  previousPending,
  readStoredPendingReview,
  rejectAllPendingHunks,
  rejectReviewHunk,
  REVIEW_UNDO_LIMIT,
  reviewSummary,
  reviewText,
  storePendingReview,
  undoReviewStep,
  walkReview,
  type HunkPlacement,
  type PendingReview,
  type ReviewHunk,
  type ReviewStep,
  type ReviewUndo,
} from './diff/review-model.ts'
import { analyzeMarkdownHtml } from './markdown-html.ts'
import { LazyMermaidMarkdown, MarkdownDocument, type MarkdownHtmlMedia } from './MarkdownHtml.tsx'
import { LargeFileView } from './LargeFileView.tsx'
import { useMarkdownSurface } from './use-markdown-surface.ts'
import { MdToc } from './md-toc.tsx'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import { localeSignature, t } from './locales.ts'
import { HTML_IFRAME_SANDBOX } from './html-preview.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** Per-file preview scroll memory. Module-level so it survives viewer
 *  remounts: the save-then-switch-to-preview reload (EditorHost #215 case B)
 *  rebuilds the whole TextEditor instance, and without this the preview
 *  would remount at the top. Keyed by session + path; a fresh entry reads 0
 *  (new file opens at the top), re-opens/toggles restore the last position. */
const previewScrollMemory = new Map<string, number>()
const previewScrollKey = (scope: { sessionId: string }, path: string): string => `${scope.sessionId}::${path}`

/**
 * How many documents' preview positions are remembered. Since v0.25 every
 * visited native tab body stays mounted (the host has no LRU), so this map
 * would otherwise grow with every file the session ever previewed; past the
 * cap the least recently written document is forgotten and its preview opens
 * at the top again — a cosmetic loss, never a wrong document.
 */
export const PREVIEW_SCROLL_CAP = 64

/**
 * Remember one document's preview offset. The write moves the key to the back
 * of the eviction order, so the document forgotten past the cap is the one
 * that has gone longest without a scroll.
 *
 * @param scope - the viewer's scope (its session id is part of the key).
 * @param path - the document's absolute path.
 * @param top - the preview container's `scrollTop`.
 */
export function rememberPreviewScroll(scope: { sessionId: string }, path: string, top: number): void {
  const key = previewScrollKey(scope, path)
  previewScrollMemory.delete(key)
  previewScrollMemory.set(key, top)
  for (const stale of previewScrollMemory.keys()) {
    if (previewScrollMemory.size <= PREVIEW_SCROLL_CAP) break
    previewScrollMemory.delete(stale)
  }
}

/** The remembered offset of one document (0 = none: open it at the top). */
export function previewScrollOf(scope: { sessionId: string }, path: string): number {
  return previewScrollMemory.get(previewScrollKey(scope, path)) ?? 0
}

/** Whether two spellings are the SAME document — byte-equal, or equal once
 *  line endings are normalized CRLF/CR → LF. Line endings are not content:
 *  CodeMirror keeps every document with `\n` endings whatever the file used,
 *  so the live document of a freshly opened CRLF file differs from the bytes
 *  it was loaded from by line endings alone. */
function sameDocument(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

/**
 * Map a line/column in one spelling of a document onto its offset in another
 * (the host's bytes may use CRLF while CodeMirror's normalized document does
 * not). Clamped to the target line, so a shrunk file can never overflow.
 */
function offsetAt(text: string, line: number, column: number): number {
  let start = 0
  let current = 1
  while (current < line) {
    const next = text.indexOf('\n', start)
    if (next < 0) return text.length
    start = next + 1
    current += 1
  }
  const end = text.indexOf('\n', start)
  return Math.min(start + column, end < 0 ? text.length : end)
}

/** The payload carried into CodeMirror's review decorations. */
interface ReviewDecorationInfo {
  review: PendingReview
  placements: ReadonlyMap<number, HunkPlacement>
  /** The hunk the action bar is on (null when the review just finished). */
  active: number | null
  /** A dirty draft must not be overwritten by a reject. */
  dirty: boolean
  onKeep: (id: number) => void
  onReject: (id: number) => void
  onPrevious: () => void
  onNext: () => void
  onKeepAll: () => void
  onRejectAll: () => void
}

const setReviewDecorations = StateEffect.define<ReviewDecorationInfo | null>()

/**
 * The removed lines of a pending hunk, in red, rendered as a block above the
 * lines that replaced them (Cursor's inline diff puts the old text inside the
 * document flow; a widget keeps the line numbers and the scroll position
 * meaningful). Covers both plain deletions and the old half of a rewrite.
 */
class RemovedLinesWidget extends WidgetType {
  constructor(
    private readonly lines: readonly string[],
    private readonly active: boolean,
  ) {
    super()
  }

  override eq(other: RemovedLinesWidget): boolean {
    return other.active === this.active
      && other.lines.length === this.lines.length
      && other.lines.every((line, index) => line === this.lines[index])
  }

  override ignoreEvent(): boolean {
    return true
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = this.active
      ? `${css.editorDiffRemoved ?? ''} ${css.editorDiffRemovedActive ?? ''}`
      : css.editorDiffRemoved ?? ''
    wrap.dataset.cursorlikeReviewRemoved = ''
    wrap.contentEditable = 'false'
    for (const line of this.lines) {
      const row = document.createElement('div')
      row.className = css.editorDiffRemovedLine ?? ''
      row.textContent = line === '' ? '\u00a0' : line
      wrap.append(row)
    }
    return wrap
  }
}

/** The action bar's data: which hunk, how far along, and the callbacks. */
interface ReviewBarInfo {
  index: number
  total: number
  remaining: number
  dirty: boolean
  onKeep: () => void
  onReject: () => void
  onPrevious: () => void
  onNext: () => void
  onKeepAll: () => void
  onRejectAll: () => void
}

/**
 * The per-hunk action bar rendered in the document flow after the hunk's last
 * line: keep or revert THIS block (which advances to the next one), navigate,
 * or resolve every remaining hunk at once. A CodeMirror widget pushes the
 * following lines down and scrolls with the text.
 */
class ReviewBarWidget extends WidgetType {
  constructor(private readonly info: ReviewBarInfo) {
    super()
  }

  override eq(other: ReviewBarWidget): boolean {
    return other.info.index === this.info.index
      && other.info.total === this.info.total
      && other.info.remaining === this.info.remaining
      && other.info.dirty === this.info.dirty
  }

  override ignoreEvent(): boolean {
    return true
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = css.editorReviewInline ?? ''
    wrap.dataset.cursorlikeReviewActions = ''
    wrap.contentEditable = 'false'

    const text = document.createElement('span')
    text.className = css.editorReviewText ?? ''
    text.textContent = t('reviewHunkProgress', {
      index: this.info.index,
      total: this.info.total,
      remaining: this.info.remaining,
    })
    wrap.append(text)

    const nav = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = css.editorReviewNav ?? ''
      button.textContent = label
      button.title = title
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
      return button
    }
    wrap.append(
      nav('‹', t('reviewPrevious'), this.info.onPrevious),
      nav('›', t('reviewNext'), this.info.onNext),
    )

    const keep = document.createElement('button')
    keep.type = 'button'
    keep.className = css.editorReviewKeep ?? ''
    keep.textContent = `${t('reviewKeepHunk')} Ctrl+K`
    keep.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.info.onKeep()
    })
    wrap.append(keep)

    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = css.editorReviewReject ?? ''
    reject.textContent = `${t('reviewRejectHunk')} Ctrl+J`
    reject.disabled = this.info.dirty
    if (this.info.dirty) reject.title = t('unsaved')
    reject.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.info.onReject()
    })
    wrap.append(reject)

    const keepAll = document.createElement('button')
    keepAll.type = 'button'
    keepAll.className = css.editorReviewKeep ?? ''
    keepAll.textContent = `${t('reviewKeepAll')} Ctrl+Alt+K`
    keepAll.disabled = this.info.remaining === 0
    keepAll.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.info.onKeepAll()
    })
    wrap.append(keepAll)

    const rejectAll = document.createElement('button')
    rejectAll.type = 'button'
    rejectAll.className = css.editorReviewReject ?? ''
    rejectAll.textContent = `${t('reviewRejectAll')} Ctrl+Alt+J`
    rejectAll.disabled = this.info.dirty
    if (this.info.dirty) rejectAll.title = t('unsaved')
    rejectAll.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.info.onRejectAll()
    })
    wrap.append(rejectAll)
    return wrap
  }
}

/** The removed text of one pending hunk (plain deletions + rewrite old halves). */
function removedLinesOf(review: PendingReview, hunk: ReviewHunk): string[] {
  const lines: string[] = []
  for (const row of hunk.rows) {
    const item = review.rows[row]
    if (item === undefined) continue
    if (item.kind === 'del' || (item.kind === 'mod' && item.newSide !== true)) lines.push(item.text)
  }
  return lines
}

/**
 * Build the review's document decorations: a red removed-lines block above
 * each changed block, a green tint on every line that stays, and the action
 * bar under the active hunk. Ranges are collected in document order; the
 * `sort` flag keeps CodeMirror tolerant of the widgets that share a line
 * boundary.
 */
function reviewDecorations(info: ReviewDecorationInfo, doc: { lines: number; line(n: number): { from: number; to: number } }): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const clamp = (line: number): number => Math.min(Math.max(1, line), Math.max(doc.lines, 1))
  for (const hunk of info.review.hunks) {
    if (hunk.decision === 'reject') continue
    const placement = info.placements.get(hunk.id)
    if (placement === undefined) continue
    const active = hunk.id === info.active
    const anchor = Math.min(placement.anchor, doc.lines)
    const removed = removedLinesOf(info.review, hunk)
    if (removed.length > 0) {
      const pos = anchor <= 0 ? 0 : doc.line(clamp(anchor)).to
      ranges.push(Decoration.widget({ widget: new RemovedLinesWidget(removed, active), side: -1 }).range(pos))
    }
    for (let index = 0; index < placement.lines; index += 1) {
      const line = clamp(anchor + 1 + index)
      const classes = [css.editorReviewLineAdd ?? '']
      if (active) {
        // The active hunk reads as one green box: stronger fill, an outline on
        // its first/last line, and a full frame around a single-line hunk.
        classes.push(css.editorReviewLineActive ?? '')
        if (placement.lines === 1) classes.push(css.editorReviewLineOnly ?? '')
        else if (index === 0) classes.push(css.editorReviewLineFirst ?? '')
        else if (index === placement.lines - 1) classes.push(css.editorReviewLineLast ?? '')
      }
      ranges.push(Decoration.line({ class: classes.filter(name => name !== '').join(' ') }).range(doc.line(line).from))
    }
    if (active) {
      // A pure-deletion hunk has no line of its own: its bar sits right under
      // the red block, at the same anchor.
      const barPos = placement.lines === 0
        ? (anchor <= 0 ? 0 : doc.line(clamp(anchor)).to)
        : doc.line(clamp(anchor + placement.lines)).to
      const remaining = info.review.hunks.filter(item => item.decision === 'pending').length
      const index = info.review.hunks.findIndex(item => item.id === hunk.id) + 1
      ranges.push(Decoration.widget({
        widget: new ReviewBarWidget({
          index,
          total: info.review.hunks.length,
          remaining,
          dirty: info.dirty,
          onKeep: () => info.onKeep(hunk.id),
          onReject: () => info.onReject(hunk.id),
          onPrevious: info.onPrevious,
          onNext: info.onNext,
          onKeepAll: info.onKeepAll,
          onRejectAll: info.onRejectAll,
        }),
        side: 1,
      }).range(barPos))
    }
  }
  return Decoration.set(ranges, true)
}

/** Decorations holding the pending review's tints, blocks and action bar. */
const reviewDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setReviewDecorations)) continue
      next = effect.value === null ? Decoration.none : reviewDecorations(effect.value, transaction.state.doc)
    }
    return next
  },
  provide: field => CodeMirrorView.decorations.from(field),
})

const REVIEW_STORE_PREFIX = 'dsh-cursorlike-sidebar:review2:'
/** The pre-per-hunk key prefix: those entries are dead (v1 reviews cannot be
 *  split into hunks) and are removed whenever the new ones are touched. */
const LEGACY_REVIEW_STORE_PREFIX = 'dsh-cursorlike-sidebar:review:'
/** Do not put whole multi-hundred-KB files into localStorage. */
const REVIEW_STORE_MAX_TEXT = 400_000

/** Stable per-session/per-file localStorage key. */
function reviewStoreKey(sessionId: string, path: string): string {
  return `${REVIEW_STORE_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(path)}`
}

/** Drop the superseded whole-file review entry of one file. */
function dropLegacyStoredReview(sessionId: string, path: string): void {
  try {
    localStorage.removeItem(`${LEGACY_REVIEW_STORE_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(path)}`)
  } catch {
    /* storage unavailable */
  }
}

/** Persist one still-pending review. Storage/quota failures are non-fatal. */
function saveStoredReview(sessionId: string, review: PendingReview): void {
  dropLegacyStoredReview(sessionId, review.path)
  if (review.base.length > REVIEW_STORE_MAX_TEXT || review.target.length > REVIEW_STORE_MAX_TEXT) return
  try {
    localStorage.setItem(reviewStoreKey(sessionId, review.path), JSON.stringify(storePendingReview(review)))
  } catch {
    /* storage unavailable: the review still works for this session */
  }
}

/** Load one pending review if the file still holds the reviewed decisions. */
function loadStoredReview(sessionId: string, path: string, content: string): PendingReview | null {
  try {
    const raw = localStorage.getItem(reviewStoreKey(sessionId, path))
    if (raw === null) return null
    const restored = readStoredPendingReview(JSON.parse(raw) as unknown, path)
    if (restored === null || restored.hunks.length === 0) return null
    // The persisted decisions were applied to disk: the file must still hold
    // exactly their reconstruction, or a newer write superseded the review.
    return sameDocument(reviewText(restored), content) ? restored : null
  } catch {
    return null
  }
}

/** Drop one persisted review (resolved, or superseded by a new change). */
function removeStoredReview(sessionId: string, path: string): void {
  dropLegacyStoredReview(sessionId, path)
  try {
    localStorage.removeItem(reviewStoreKey(sessionId, path))
  } catch {
    /* storage unavailable */
  }
}

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, size, largeFile, line } = props
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  /** The agent's change, split into per-hunk decisions (null = no review). */
  const [review, setReview] = useState<PendingReview | null>(null)
  const reviewRef = useRef<PendingReview | null>(null)
  /** The finished review's summary, kept for the undo bar after it closes. */
  const [reviewResult, setReviewResult] = useState<{ kind: 'keep' | 'reject'; kept: number; rejected: number } | null>(null)
  /** Review actions awaitable in order (a reject writes before the next one). */
  const reviewQueueRef = useRef<Promise<void>>(Promise.resolve())
  /** One undo entry per decision, newest last. */
  const reviewUndoRef = useRef<{ review: PendingReview; undo: ReviewUndo }[]>([])
  /** How many undo entries exist (React-visible mirror of the ref). */
  const [undoCount, setUndoCount] = useState(0)
  /** The undo bar's container (its Ctrl+Z must not be swallowed by CodeMirror). */
  const undoBarRef = useRef<HTMLDivElement>(null)
  /** Content/path seen by the last render, for agent-edit detection. */
  const previousContentRef = useRef<{ path: string; text: string | undefined }>({ path, text: content })
  /** The first content after a path switch is a load, never an agent edit. */
  const skipReviewRef = useRef(false)
  /** Set while a programmatic reject/undo replaces the document, so the
   *  content-changed listener does not turn it into an unsaved draft. */
  const suppressDirtyRef = useRef(false)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  /** The save was refused because the file changed on disk (fs-conflict). */
  const [conflict, setConflict] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The mtime the draft is based on (`null` = the file did not exist yet).
   *  Seeded from the load, refreshed by every successful save, and reset by
   *  the file-switch effect. */
  const mtimeRef = useRef<number | null>(props.mtimeMs ?? null)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The search-phrases compartment of the current view (reconfigured on a
   *  language switch — the panel copy is baked into the EditorState). */
  const searchPhrasesRef = useRef<CmSearchPhrases | null>(null)
  /** The uncommitted-change gutter compartment (issue #212; reconfigured on a
   *  setting flip instead of rebuilding the view). */
  const gitCompRef = useRef<CmGitGutterCompartment | null>(null)
  /** The effective UI language (DSH locale id + better-locale override id).
   *  Read during render and subscribed below: the tab-cell memo only
   *  compares the DSH locale revision, so a better-locale override switch
   *  would otherwise never reach this component. */
  const [localeSig, setLocaleSig] = useState(() => localeSignature())
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement | null>(null)
  /** Heading slugs, anchor jumps and `.md` link claiming for the preview (the
   *  delegate provider wrapped around the markdown is its claim boundary — see
   *  use-markdown-surface). */
  const { surfaceRef: markdownSurfaceRef, openFile: openSurfaceFile } = useMarkdownSurface({
    ctx,
    sessionId: scope.sessionId,
    cwd: scope.cwd,
    path,
  })
  /** One ref callback for the preview container: the selection/scroll code
   *  above keeps its object ref, the surface installer gets the same element.
   *  A stable identity matters — a fresh callback on every render would make
   *  React re-attach (and re-scan) on every render. */
  const previewRef = useCallback((element: HTMLDivElement | null) => {
    mdRef.current = element
    markdownSurfaceRef(element)
  }, [markdownSurfaceRef])
  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  /** Newline-delimited JSON: it has its own preview (one card per record) on
   *  top of the shared editable CodeMirror surface. */
  const jsonl = viewerId === 'jsonl'
  /** The file is above the editable threshold: the viewer renders the
   *  read-only paged preview and no editor at all. */
  const readOnly = largeFile !== undefined
  /** Whether the host has handed the document over. The view is built once per
   *  path (not once per content value) so an agent write can update it in place. */
  const hasContent = content !== undefined
  /** The uncommitted-change gutter (issue #212): the `code` viewer only,
   *  gated by ONE boolean setting (on by default). Nothing else — no
   *  end-of-line author widget, no badges, no animation. Read reactively
   *  (same seam as the host's editorExplorer read) so flipping the switch
   *  reconfigures the live view in place instead of waiting for a reopen. */
  const gitGutterPref = useSyncExternalStore(
    useCallback((callback: () => void) => props.store.subscribe(callback), [props.store]),
    useCallback(() => props.store.getSnapshot().prefs.editorGitGutter !== false, [props.store]),
    // Server snapshot: this component is rendered to a string by the markdown
    // preview specs. The value only feeds effects (the extensions are built
    // client-side), so the store answers on both sides alike.
    useCallback(() => props.store.getSnapshot().prefs.editorGitGutter !== false, [props.store]),
  )
  const gitGutterEnabled = (viewerId === 'code' || viewerId === 'jsonl') && gitGutterPref
  /** Bumped by every save: the uncommitted diff moved while the file's git
   *  status entry (which only tracks its XY code) did not. */
  const [gitRevision, setGitRevision] = useState(0)
  /** The view-side identity of the gutter's git source (stable across the
   *  scope object's per-render identity churn). */
  const gitHost = useMemo<GitGutterHost>(
    () => ({ scope: { sessionId: scope.sessionId, cwd: scope.cwd, repoRoot: scope.repoRoot }, path }),
    [scope.sessionId, scope.cwd, scope.repoRoot, path],
  )
  const gitKinds = useEditorGitGutter({
    enabled: gitGutterEnabled,
    // A parked native tab stays MOUNTED (`keepMounted`), so the tab's own
    // visibility is what decides whether the gutter does git work at all: a
    // hidden editor holds no status subscription and no timer.
    visible: props.visible !== false,
    scope,
    path,
    content,
    revision: gitRevision,
  })
  /** Preview scroll position across the preview<->edit toggle. The preview
   *  container re-mounts on every mode switch and its scrollTop lives on that
   *  element, so capture it on scroll and restore after each remount. Seeded
   *  from the module-level per-file memory so a full viewer rebuild
   *  (save-then-switch-to-preview reload) also keeps the position. */
  const previewScrollRef = useRef(previewScrollOf(scope, path))
  /** True while a programmatic restore is in flight; raw scroll events caused
   *  by the restore (or by the browser clamping a collapsed reload container
   *  to 0) must not overwrite the remembered position. */
  const restoringRef = useRef(false)
  /** Preview-side handoff data for the preview -> edit switch: the text at the
   *  top of the preview viewport (best-effort) plus the scroll ratio. Captured
   *  throttled on preview scroll; consumed when entering edit mode so the
   *  editor opens where the reader was instead of at the file top. */
  const previewSyncRef = useRef<{ text: string | null; ratio: number }>({ text: null, ratio: 0 })
  const anchorThrottleRef = useRef(false)

  /**
   * The Ctrl/Cmd+L payload from the live surface, mirroring Cursor: the
   * selected text when there is a selection, otherwise the caret's current
   * line. Reading the LIVE CodeMirror selection (rather than reusing the
   * floating popup's stored payload) is what keeps the shortcut working
   * after the popup was dismissed by a scroll, an outside mousedown or a
   * window blur — Cursor's gesture does not depend on a visible button.
   *
   * The preview branch maps the DOM selection back to source lines (best
   * effort, see {@link linesOfSelection}); CodeMirror already knows its own
   * line numbers exactly.
   */
  const resolveSelectionInsert = (): SelectionReference | null => {
    if (markdown && mode === 'preview') {
      const host = mdRef.current
      const sel = window.getSelection()
      if (host === null || sel === null || sel.isCollapsed) return null
      if (sel.anchorNode === null || sel.focusNode === null) return null
      if (!host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) return null
      const text = sel.toString()
      if (text.trim() === '') return null
      const lines = linesOfSelection(draft ?? content ?? '', text)
      return { path, lines: lines ?? undefined, text }
    }
    const view = viewRef.current
    if (view === null) return null
    const selection = view.state.selection.main
    const doc = view.state.doc
    if (selection.empty) {
      // No selection: add the current line, exactly like Cursor's Ctrl+L.
      const lineAtCaret = doc.lineAt(selection.head)
      if (lineAtCaret.text.trim() === '') return null
      return { path, lines: { start: lineAtCaret.number, end: lineAtCaret.number } }
    }
    const text = view.state.sliceDoc(selection.from, selection.to)
    if (text.trim() === '') return null
    return {
      path,
      lines: {
        start: doc.lineAt(selection.from).number,
        end: doc.lineAt(selection.to).number,
      },
    }
  }

  /**
   * The floating "add to conversation" popup (viewport-anchored; null =
   * hidden). The hook owns show/hide/commit plus the global dismissal
   * listeners (outside mousedown, Escape, hidden tab/window, surface
   * leaving the viewport) — see selection-popup.ts.
   */
  const selectionPopup = useSelectionPopup<SelectionReference>({
    placement: 'surface-bottom-right',
    sessionId: scope.sessionId,
    onCommit: (reference) => { insertSelectionReference(ctx, scope.sessionId, reference) },
    label: () => t('addToConversation'),
    onDrag: (transfer, reference) => { writeSelectionDrag(transfer, scope.sessionId, reference) },
    // The surface that must stay on screen: the markdown preview container
    // in preview mode, the CodeMirror host otherwise. The editor branch is
    // only live while CodeMirror actually holds focus: its DOM text selection
    // survives a focus move to another surface (the explorer keeps the last
    // selection painted for a moment), and accepting that anchor would make a
    // Ctrl+L typed in the file tree insert the editor's stale line instead of
    // the focused file reference.
    getSurface: () => {
      if (markdown && mode === 'preview') return mdRef.current
      return viewRef.current?.hasFocus === true ? hostRef.current : null
    },
    // Ctrl/Cmd+L works even when the floating button is gone.
    resolve: resolveSelectionInsert,
  })

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // Keep `localeSig` fresh from BOTH language sources: the DSH locale service
  // and (when @huanlin/dsh-plugin-better-locale is installed) the override
  // store. The sidebar root re-renders the tree on a DSH locale switch, but
  // an override switch is not part of the tab-cell memo key, so this
  // component subscribes directly instead of relying on a parent render.
  useEffect(() => {
    const sync = (): void => { setLocaleSig(localeSignature()) }
    sync()
    const locale = ctx.locale as { subscribe?: (cb: () => void) => () => void } | undefined
    type BetterLocaleStore = { subscribe?(listener: () => void): () => void }
    const betterLocale = typeof ctx.get === 'function'
      ? (ctx as unknown as { get(name: 'betterLocale'): BetterLocaleStore | undefined }).get('betterLocale')
      : undefined
    const offLocale = locale?.subscribe?.(sync)
    const offOverride = betterLocale?.subscribe?.(sync)
    return () => {
      offLocale?.()
      offOverride?.()
    }
  }, [ctx])

  // A new file (path swap) starts clean: fresh preview mode, no draft, no
  // pending review. Same-path content updates are NOT a new file any more —
  // the host publishes an agent write as a new `content` value with the view
  // still mounted (see the sync effect below), so resetting here on every
  // change would drop the reader's mode and the review itself.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    setConflict(false)
    reviewRef.current = null
    reviewUndoRef.current = []
    setUndoCount(0)
    setReview(null)
    setReviewResult(null)
    // The freshly loaded bytes are the new save baseline.
    mtimeRef.current = props.mtimeMs ?? null
    selectionPopup.hide()
    // hide() reads a live ref; the reset must fire only on a path swap, and
    // the hook object's identity churns on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // Detect an agent/external edit: the host publishes new `content` without the
  // editor typing. The change is split into per-hunk decisions (the inline
  // review): Keep/Revert apply to the bar's hunk and advance to the next one.
  useEffect(() => {
    const previous = previousContentRef.current
    previousContentRef.current = { path, text: content }
    if (content === undefined) return
    if (previous.path !== path) {
      reviewRef.current = null
      setReview(null)
      setReviewResult(null)
      skipReviewRef.current = true
      return
    }
    if (skipReviewRef.current) {
      skipReviewRef.current = false
      return
    }
    if (previous.text === undefined || sameDocument(previous.text, content)) return
    // The host only republishes bytes it just read: adopt its mtime as the new
    // save baseline even when the review itself is suppressed below (a dirty
    // draft, an oversized file), or the next save would report fs-conflict.
    mtimeRef.current = props.mtimeMs ?? mtimeRef.current
    if (readOnly || dirtyRef.current) return
    // Above this size the LCS table is not worth blocking the editor on;
    // the Changes tab remains the diff surface for huge files.
    if (previous.text.length + content.length > 400_000) return
    const next = buildPendingReview(previous.text, content, path)
    if (next.hunks.length === 0) return
    reviewRef.current = next
    reviewUndoRef.current = []
    setUndoCount(0)
    setReviewResult(null)
    setReview(next)
    saveStoredReview(scope.sessionId, next)
    // The effect reads the host's current mtime alongside the new bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path, readOnly])

  // Restore a pending review after a restart when the file still holds the
  // reviewed decisions' reconstruction. Resolving the review clears the entry.
  useEffect(() => {
    if (content === undefined || reviewRef.current !== null) return
    const stored = loadStoredReview(scope.sessionId, path, content)
    if (stored === null) return
    reviewRef.current = stored
    reviewUndoRef.current = []
    setUndoCount(0)
    previousContentRef.current = { path, text: content }
    setReview(stored)
  }, [content, path, scope.sessionId])

  // External content -> live document, IN PLACE. The view (and its history,
  // scroll and — for a reader who is just looking — the caret) survives an
  // agent write instead of being torn down and rebuilt. A dirty draft always
  // wins: the host does not refresh a dirty tab, and if a caller does republish
  // bytes anyway the user's unsaved input must not be overwritten. The
  // transaction stays out of CodeMirror's undo history so Ctrl+Z keeps undoing
  // the user's TYPING, not the model's edit.
  useEffect(() => {
    const view = viewRef.current
    if (view === null || content === undefined || dirtyRef.current) return
    const doc = view.state.doc
    const live = doc.toString()
    if (sameDocument(live, content)) {
      mtimeRef.current = props.mtimeMs ?? mtimeRef.current
      return
    }
    const selection = view.state.selection.main
    const headLine = doc.lineAt(selection.head)
    const anchorLine = doc.lineAt(selection.anchor)
    const target = offsetAt(content, headLine.number, selection.head - headLine.from)
    const anchor = offsetAt(content, anchorLine.number, selection.anchor - anchorLine.from)
    suppressDirtyRef.current = true
    try {
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
        selection: { anchor, head: target },
        annotations: Transaction.addToHistory.of(false),
      })
    } finally {
      suppressDirtyRef.current = false
    }
    mtimeRef.current = props.mtimeMs ?? mtimeRef.current
    setDraft(null)
    // props.mtimeMs rides the same host update as `content`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path])

  // A different file switches the remembered preview scroll position to that
  // file's own entry (first open: none, so the preview starts at the top).
  useEffect(() => {
    previewScrollRef.current = previewScrollOf(scope, path)
  }, [scope, path])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document through its whole lifetime on a path: a later `content` value
  // is applied as a transaction by the sync effect above instead of rebuilding
  // the view (a rebuild would throw away the undo history, the scroll position
  // and — critically — the pending review). The theme + syntax colors live in
  // a compartment so a scheme flip reconfigures only that part.
  useEffect(() => {
    if (content === undefined) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    const searchPhrases = new CmSearchPhrases()
    searchPhrasesRef.current = searchPhrases
    const gitComp = new CmGitGutterCompartment()
    gitCompRef.current = gitComp
    const state = EditorState.create({
      doc: content,
      extensions: [
        CodeMirrorView.lineWrapping,
        reviewDecorationField,
        // The change bar sits BEFORE the line numbers (VS Code's own order):
        // a thin colored bar at the far left, the number tinted beside it.
        // The compartment carries all of it (hover blame included), so the
        // setting can flip it in place below.
        gitComp.of(gitGutterEnabled ? gitHost : null),
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        // Find-in-file (Cmd/Ctrl+F): the top-pinned search panel plus the
        // upstream search keymap, registered BEFORE the editor's own keymap
        // below so the search bindings (Escape in particular — the editor
        // keymap's `simplifySelection` shares that key) win while the panel
        // is open, and the save key stays in the editor keymap unchanged.
        ...cmSearchExtensions(),
        searchPhrases.of(),
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged && !suppressDirtyRef.current) {
            setDirty(true)
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Selection popup (the code and markdown editors): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' || viewerId === 'markdown' || viewerId === 'jsonl' ? [
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              selectionPopup.hide()
              return
            }
            if (!update.view.hasFocus) {
              selectionPopup.hide()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            const sel = update.state.selection.main
            if (sel.empty) {
              selectionPopup.hide()
              return
            }
            const text = update.state.sliceDoc(sel.from, sel.to)
            if (text.trim() === '') {
              selectionPopup.hide()
              return
            }
            // Page coordinates (the document root may scroll); the popup is
            // position:fixed, so convert to viewport coordinates.
            const rect = update.view.coordsAtPos(sel.head)
            if (rect === null) {
              selectionPopup.hide()
              return
            }
            const doc = update.state.doc
            selectionPopup.show(
              {
                path,
                lines: {
                  start: doc.lineAt(sel.from).number,
                  end: doc.lineAt(sel.to).number,
                },
              },
              rect.left - window.scrollX + (rect.right - rect.left) / 2,
              rect.top - window.scrollY,
            )
          }),
        ] : []),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    // Native selection drags carry the structured file+line payload, not only
    // the browser's plain text. The drop handler then inserts the same
    // `@file line X-Y` reference as Ctrl+L.
    const onDragStart = (event: DragEvent): void => {
      if (event.dataTransfer === null) return
      const selection = view.state.selection.main
      if (selection.empty) return
      const text = view.state.sliceDoc(selection.from, selection.to)
      if (text.trim() === '') return
      const doc = view.state.doc
      writeSelectionDrag(event.dataTransfer, scope.sessionId, {
        path,
        lines: {
          start: doc.lineAt(selection.from).number,
          end: doc.lineAt(selection.to).number,
        },
      })
    }
    host.addEventListener('dragstart', onDragStart)
    return () => {
      host.removeEventListener('dragstart', onDragStart)
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
      searchPhrasesRef.current = null
      gitCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
    // `hasContent` lets a viewer mounted before its read lands still build the
    // view: a string->string content change must NOT recreate it (the sync
    // effect above applies that transaction in place).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, hasContent])

  // Native sidebar tabs stay mounted while another tab is active. If a file
  // is opened while that host is hidden, CodeMirror can measure its viewport at
  // zero and retain an empty virtualized viewport after the tab is revealed —
  // the gutter still draws its line numbers while the document body stays
  // blank. Re-measure on every reveal, not just on a box-size change: the
  // host's `retainTab` parks a body by MOVING it into a hidden seat and back,
  // and moving a node never changes its border box, so a ResizeObserver alone
  // never fires for that path. An IntersectionObserver reports the reveal
  // itself; the rAF follow-up covers a reveal landing in the mount's own frame,
  // where CodeMirror's first measure may still have read a zero box.
  useEffect(() => {
    const host = hostRef.current
    const view = viewRef.current
    if (host === null || view === null) return
    const measure = (): void => {
      if (host.isConnected && host.offsetWidth > 0 && host.offsetHeight > 0) view.requestMeasure()
    }
    measure()
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => { measure() })
      : undefined
    const disposers: (() => void)[] = []
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(measure)
      resize.observe(host)
      disposers.push(() => { resize.disconnect() })
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const intersection = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) measure()
      })
      intersection.observe(host)
      disposers.push(() => { intersection.disconnect() })
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') measure()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', measure)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      for (const dispose of disposers) dispose()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', measure)
    }
  }, [content, path])

  /** The landing line already honoured, as `${path}#${line}`. The host keeps a
   *  visited tab body mounted (`keepMounted`) and re-delivers its navigation on
   *  every store notification, so without this a reader would be yanked back to
   *  the same line each time — while a NEW line on the SAME file must land. */
  const landedAtRef = useRef<string | null>(null)

  // Land on the line a file reference named (`a/b.c#L131`, `a/b.c:131` — #826).
  // One-shot per (file, line): an ordinary open carries no line and never
  // fires, and a fresh reference re-fires it.
  useEffect(() => {
    if (line === undefined) {
      landedAtRef.current = null
      return
    }
    if (content === undefined) return
    const view = viewRef.current
    if (view === null) return
    const key = `${path}#${line}`
    if (landedAtRef.current === key) return
    // A markdown/html/jsonl file opens in a preview, which has no source lines
    // to put a cursor on. The reference asked for source, so land in the
    // editor; the key is NOT recorded yet, so the re-run after the flip jumps.
    if ((markdown || html || jsonl) && mode === 'preview') {
      setMode('edit')
      return
    }
    landedAtRef.current = key
    // The reference asked for a LINE, so it wins over the preview's remembered
    // reading position: the flip's own "enter edit where the reader was" effect
    // is declared AFTER this one and would otherwise re-dispatch (and re-scroll
    // to) the preview position in the same commit, silently undoing the jump.
    previewSyncRef.current = { text: null, ratio: 0 }
    // Out-of-range references clamp to the last line rather than throwing —
    // the file can have changed since the link was written.
    const doc = view.state.doc
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines)).from
    // Position by writing the editor's OWN scroller (after a fresh measure)
    // instead of CodeMirror's scrollIntoView: that path walks every scrollable
    // ancestor — and even the window when the browser is zoomed
    // (visualViewport < innerHeight) — which dragged the whole sidebar up when
    // the reader was at the very end of the document. A plain scrollTop write
    // on the editor scroller can never touch anything outside the editor.
    view.requestMeasure()
    view.dispatch({ selection: { anchor: target } })
    // Show the caret. A selection alone is invisible here: CodeMirror draws the
    // cursor only in a FOCUSED editor, and a zero-length selection paints
    // nothing — so an unfocused landing read as "the file just opened
    // somewhere" (reported from the first manual test of this feature). Only a
    // line reference focuses; an ordinary open leaves the reader's focus where
    // it was (e.g. in the chat composer they clicked the link from).
    view.focus()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const block = view.lineBlockAt(target)
        view.scrollDOM.scrollTop = Math.max(0, block.top - 8)
        // CodeMirror's scroll-observer is async and can lag a direct write, so
        // force a re-measure at the NEW scroll position or the virtualized
        // viewport keeps rendering the old one.
        view.requestMeasure()
      })
    })
    // The navigation is SPENT now: tell the host, which owns that memory (a
    // reload remounts this component, and a fresh instance handed the same line
    // again would re-force a markdown/html file into the editor — the reader
    // could never click their way back to preview).
    props.onLineConsumed?.()
    // The reveal reads the live view ref; `markdown`/`html` are derived from
    // `viewerId`, which the view-creation effect already keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path, line, mode, props.onLineConsumed])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // Language switch: re-resolve the search panel copy in place. CodeMirror
  // reads the `phrases` facet when it builds the panel, so the compartment
  // must be reconfigured for the new language (the document, history,
  // scroll, and keymaps survive — same in-place pattern as the theme flip).
  useEffect(() => {
    const view = viewRef.current
    const searchPhrases = searchPhrasesRef.current
    if (view === null || searchPhrases === null) return
    view.dispatch({ effects: searchPhrases.reconfigure() })
  }, [localeSig])

  // The uncommitted-change gutter follows the setting in place: the
  // compartment swap installs (or removes) the decoration extensions and the
  // hover blame without rebuilding the view — the document, history and
  // scroll survive, exactly like the theme and search flips above.
  useEffect(() => {
    const view = viewRef.current
    const gitComp = gitCompRef.current
    if (view === null || gitComp === null) return
    view.dispatch({ effects: gitComp.reconfigure(gitGutterEnabled ? gitHost : null) })
  }, [gitGutterEnabled, gitHost])

  // Push the line map into the live view. `content` re-runs this after the
  // view was rebuilt for a new file, and `gitGutterEnabled` after a re-install
  // (a reconfigured state field starts empty).
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    applyGitLineKinds(view, gitKinds)
  }, [gitKinds, gitGutterEnabled, content, path])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal). A mode
  // flip also invalidates any anchored selection popup. When entering edit
  // from a scrolled preview, the editor opens where the reader was: the line
  // mapped from the text anchored at the preview viewport top (or, failing a
  // unique text match, the proportional scroll position).
  useEffect(() => {
    selectionPopup.hide()
    if (mode !== 'edit') return
    const view = viewRef.current
    if (view === null) return
    const sync = previewSyncRef.current
    if (!markdown) return
    const doc = view.state.doc
    let target: number | undefined
    if (sync.text !== null) {
      const lines = linesOfSelection(mdText, sync.text)
      if (lines !== null) target = doc.line(Math.min(lines.start, doc.lines)).from
    }
    // ratio === 1 means the reader was at the very bottom (e.g. the last
    // block's text is a repeated filler line that linesOfSelection rejects
    // as ambiguous) — it must still land the editor at the bottom.
    if (target === undefined && sync.ratio > 0 && sync.ratio <= 1) {
      target = Math.max(1, Math.min(doc.length - 1, Math.round(doc.length * sync.ratio)))
    }
    if (target === undefined) return
    // Position the editor by writing its OWN scroller directly (after a fresh
    // measure) instead of CodeMirror's scrollIntoView: that path walks every
    // scrollable ancestor — and even the window when the browser is zoomed
    // (visualViewport < innerHeight) — to reveal the target, which dragged
    // the whole sidebar up when the reader was at the very end of the
    // document. A plain scrollTop write on the editor scroller can never
    // touch anything outside the editor.
    view.requestMeasure()
    view.dispatch({ selection: { anchor: target } })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const block = view.lineBlockAt(target)
        view.scrollDOM.scrollTop = Math.max(0, block.top - 8)
        // Force CodeMirror to re-measure and re-render its virtualized
        // viewport at the NEW scroll position (its scroll-observer is async
        // and can lag a direct write).
        view.requestMeasure()
      })
    })
    // The reveal reads the live document/view refs; only the flip into
    // preview triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Snapshot the live document into the draft whenever the preview needs
  // it: entering preview (the markdown preview renders `draft ?? content`)
  // and a content swap (the view was just re-created above, so the read is
  // the new document — matching the reset-to-null of a clean tab). The
  // updateListener used to re-stringify the WHOLE document on every
  // keystroke (O(docLength) per key) for a draft only preview reads.
  //
  // Only an EDIT becomes a draft. Publishing the live document when it is the
  // loaded content under another line-ending spelling (CodeMirror normalizes
  // CRLF → LF, so that is every CRLF file) would hand the preview a second
  // spelling of the same document one render after the mount: the renderer
  // rebuilds the markdown elements it owns, and every DOM-side pass result
  // written onto them — heading ids, collapsed anchors — is discarded with
  // them until the surface's MutationObserver re-runs (a microtask later,
  // i.e. after a synchronous caller has already looked).
  useEffect(() => {
    const view = viewRef.current
    if (view === null) { setDraft(null); return }
    const live = view.state.doc.toString()
    setDraft(content !== undefined && sameDocument(live, content) ? null : live)
  }, [mode, content])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    const text = view.state.doc.toString()
    savingRef.current = true
    setSaveState('saving')
    // Optimistic concurrency: the draft was based on the bytes read at
    // `mtimeMs`; a file that changed on disk since is REFUSED (fs-conflict)
    // instead of clobbering whatever wrote it (the model, another tab, an
    // external editor). `null` = the file did not exist when loaded.
    api.fsWrite(scope, path, text, mtimeRef.current ?? null).then((result) => {
      savingRef.current = false
      // Adopt the fresh baseline the host reports (absent on a stat failure —
      // keep the old one, the next save just re-checks).
      if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
      setDraft(null)
      setDirty(false)
      setConflict(false)
      setSaveState('saved')
      // The saved bytes are the new revision every later comparison starts
      // from: saving an agent edit IS accepting it, and it must not come back
      // as "changed by the model" against the pre-edit bytes on the next write.
      previousContentRef.current = { path, text }
      // Saving the whole document resolves whatever review was open on it.
      if (reviewRef.current !== null) {
        reviewRef.current = null
        reviewUndoRef.current = []
        setUndoCount(0)
        setReview(null)
        setReviewResult(null)
        removeStoredReview(scope.sessionId, path)
      }
      // The saved bytes are a new revision of the uncommitted diff: re-read
      // the change set (the file's XY status code usually stays the same, so
      // the status store alone would never wake the gutter up again).
      setGitRevision(value => value + 1)
    }).catch((error: unknown) => {
      savingRef.current = false
      if (error instanceof SidebarApiError && error.code === 'fs-conflict') {
        setConflict(true)
        setSaveState('idle')
        return
      }
      setSaveState('failed')
    })
  }

  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''
  /** Preview-only source with a closed leading YAML frontmatter block hidden.
   *  The raw `mdText` stays untouched for editing, saving, and selection line
   *  lookup. All preview renderers share this source so plain Markdown,
   *  Mermaid, and documents containing raw HTML behave consistently. */
  const previewMdText = markdown ? markdownPreviewSource(mdText) : mdText

  // Re-apply the remembered preview scroll position whenever the preview
  // container mounts or its content changes (mode flip back to preview, or a
  // same-file reload — e.g. the save-then-switch-to-preview reload — which
  // temporarily collapses the container and clamps scrollTop to 0). Restored
  // in a before-paint layout effect so the user never sees the top flash.
  useLayoutEffect(() => {
    if (mode !== 'preview') return
    const el = mdRef.current
    if (el === null || previewScrollRef.current <= 0) return
    if (el.scrollHeight <= el.clientHeight) return
    if (el.scrollTop === previewScrollRef.current) return
    restoringRef.current = true
    el.scrollTop = previewScrollRef.current
    requestAnimationFrame(() => { restoringRef.current = false })
  }, [mode, previewMdText])

  /** The preview source with local image destinations rewritten to absolute
   *  media URLs (see {@link rewriteLocalImageUrls}) and the local link
   *  destinations prepared for the host delegate (see
   *  {@link rewriteLocalMarkdownLinks}; the split renderer runs the same two
   *  passes per markdown run, and both are idempotent). */
  const previewText = markdown
    ? rewriteLocalMarkdownLinks(
      rewriteLocalImageUrls(previewMdText, scope, path, hostTransportBase()),
      path,
      scope.cwd,
    )
    : previewMdText
  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(previewMdText) : []),
    [markdown, mode, previewMdText],
  )
  /** Raw-HTML analysis (block runs lifted out + inline gate). Non-null for
   *  every markdown preview, so the render below always takes the split
   *  renderer — its markdown runs rewrite local image destinations internally
   *  (see MarkdownHtml.tsx). The legacy single-pass branches (fed the
   *  pre-rewritten `previewText`) are dead in the current wiring. */
  const htmlInfo = useMemo(
    () => (markdown && mode === 'preview' ? analyzeMarkdownHtml(previewMdText) : null),
    [markdown, mode, previewMdText],
  )
  const hasMermaid = useMemo(
    () => htmlInfo !== null
      ? htmlInfo.segments.some((segment) => segment.kind === 'markdown'
        && splitMermaidBlocks(segment.text).some((block) => block.kind === 'mermaid'))
      : mdBlocks.some((block) => block.kind === 'mermaid'),
    [htmlInfo, mdBlocks],
  )
  /** The media context for the split renderer (local-src rewriting inside
   *  sanitized HTML). Memoized on primitives: MarkdownDocument sanitizes per
   *  `media` identity, so a fresh object per render would re-sanitize every
   *  keystroke. */
  const htmlMedia = useMemo<MarkdownHtmlMedia>(
    () => ({ scope, path, baseUrl: hostTransportBase() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd, path],
  )
  const codeLabels = {
    copyLabel: t('copy'),
    copiedLabel: t('copied'),
    codeLabel: t('codeBlockTitle'),
    wrapLabel: t('codeBlockWrap'),
    unwrapLabel: t('codeBlockUnwrap'),
  }

  /**
   * Selection popup for the markdown preview: a mouse-up inside the preview
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handlePreviewMouseUp = (): void => {
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
      selectionPopup.hide()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      selectionPopup.hide()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      selectionPopup.hide()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(mdText, text)
    selectionPopup.show(
      { path, lines: lines ?? undefined, text },
      rect.left + rect.width / 2,
      rect.top,
    )
  }
  const editable = content !== undefined
  /**
   * Whether the preview/edit toggle applies. It needs BOTH surfaces to exist:
   * a read-only paged preview has no editor to switch to, and the `code`
   * catch-all has no preview to switch to.
   */
  const toggleable = !readOnly && (markdown || html || jsonl)
  /** A non-CodeMirror surface currently owns the pane (markdown/html render, or
   *  the JSONL record list): the CodeMirror host stays mounted but hidden, so
   *  unsaved edits survive the round trip. */
  const showingPreview = !readOnly && mode === 'preview' && (markdown || html || jsonl)
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''

  /** Replace the live document when a review decision changes its bytes. */
  const replaceEditorText = (text: string): void => {
    const view = viewRef.current
    suppressDirtyRef.current = true
    setDraft(text)
    setDirty(false)
    if (view !== null) {
      const doc = view.state.doc
      const selection = view.state.selection.main
      const headLine = doc.lineAt(selection.head)
      const target = Math.min(selection.head - headLine.from, Math.max(0, text.length - 1))
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: text },
        selection: { anchor: offsetAt(text, Math.min(headLine.number, Math.max(1, text.split('\n').length)), target) },
        annotations: Transaction.addToHistory.of(false),
      })
    }
    queueMicrotask(() => { suppressDirtyRef.current = false })
  }

  /** Publish one applied review state to React, storage and the document. */
  const applyReviewState = (next: PendingReview, text: string | null): void => {
    reviewRef.current = next
    const documentText = text ?? reviewText(next)
    if (text !== null) {
      replaceEditorText(text)
      setGitRevision(value => value + 1)
    }
    previousContentRef.current = { path, text: documentText }
    if (next.decided) {
      setReview(null)
      const summary = reviewSummary(next)
      setReviewResult({
        kind: summary.rejected > 0 ? 'reject' : 'keep',
        kept: summary.kept,
        rejected: summary.rejected,
      })
      removeStoredReview(scope.sessionId, path)
    } else {
      setReviewResult(null)
      setReview(next)
      saveStoredReview(scope.sessionId, next)
    }
  }

  /** Run review actions one at a time: a reject writes before the next step. */
  const enqueueReview = (task: () => Promise<void>): void => {
    reviewQueueRef.current = reviewQueueRef.current.then(task, task).catch(() => {})
  }

  /** Record one step's undo entry (bounded) and publish its state. */
  const commitReviewStep = (step: ReviewStep): void => {
    reviewUndoRef.current.push({ review: step.review, undo: step.undo })
    if (reviewUndoRef.current.length > REVIEW_UNDO_LIMIT) reviewUndoRef.current.shift()
    setUndoCount(reviewUndoRef.current.length)
    applyReviewState(step.review, step.text)
    queueMicrotask(() => { viewRef.current?.focus() })
  }

  /** Keep one hunk (the bar's, or the clicked one) and advance to the next. */
  const keepHunk = (id?: number): void => {
    const before = reviewRef.current
    if (before === null) return
    const targetId = id ?? activeHunkOf(before)
    if (targetId === null) return
    const step = keepReviewHunk(before, targetId)
    if (step.review === before) return
    commitReviewStep(step)
  }

  /** Reject one hunk: write the old-side bytes, then advance. */
  const rejectHunk = (id?: number): void => {
    const current = reviewRef.current
    if (current === null || dirtyRef.current) return
    const targetId = id ?? activeHunkOf(current)
    if (targetId === null) return
    enqueueReview(async () => {
      const before = reviewRef.current
      if (before === null || dirtyRef.current) return
      const step = rejectReviewHunk(before, targetId)
      if (step.text === null || step.review === before) return
      try {
        const result = await api.fsWrite(scope, path, step.text, mtimeRef.current)
        if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
        commitReviewStep(step)
      } catch {
        setSaveState('failed')
      }
    })
  }

  /** Keep every remaining hunk in one step (Ctrl+Alt+K). */
  const keepAllHunks = (): void => {
    const before = reviewRef.current
    if (before === null || !before.hunks.some(hunk => hunk.decision === 'pending')) return
    const step = keepAllReviewHunks(before)
    commitReviewStep(step)
  }

  /** Reject every remaining hunk in one step (Ctrl+Alt+J). */
  const rejectAllHunks = (): void => {
    if (reviewRef.current === null || dirtyRef.current) return
    enqueueReview(async () => {
      const before = reviewRef.current
      if (before === null || dirtyRef.current) return
      if (!before.hunks.some(hunk => hunk.decision === 'pending')) return
      const step = rejectAllPendingHunks(before)
      if (step.text === null) return
      try {
        const result = await api.fsWrite(scope, path, step.text, mtimeRef.current)
        if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
        commitReviewStep(step)
      } catch {
        setSaveState('failed')
      }
    })
  }

  /** Move the bar to the next/previous pending hunk (no decision). */
  const navigateReview = (direction: 'next' | 'previous'): void => {
    const current = reviewRef.current
    if (current === null) return
    const active = activeHunkOf(current)
    if (active === null) return
    const targetId = direction === 'next'
      ? nextPending(active, current.hunks)
      : previousPending(active, current.hunks)
    if (targetId === null || targetId === active) return
    const next: PendingReview = { ...current, active: targetId }
    reviewRef.current = next
    setReview(next)
    queueMicrotask(() => { viewRef.current?.focus() })
  }

  /** Undo the last review decision (Ctrl+Z). */
  const undoReviewStepAction = (): void => {
    if (dirtyRef.current) return
    const entry = reviewUndoRef.current[reviewUndoRef.current.length - 1]
    if (entry === undefined || reviewRef.current === null) return
    const restored = undoReviewStep(entry.review, entry.undo)
    const commit = (): void => {
      const last = reviewUndoRef.current[reviewUndoRef.current.length - 1]
      if (last === entry) reviewUndoRef.current.pop()
      setUndoCount(reviewUndoRef.current.length)
      setReviewResult(null)
      applyReviewState(restored.review, restored.text)
      queueMicrotask(() => { viewRef.current?.focus() })
    }
    if (restored.text === null) {
      commit()
      return
    }
    const writeText = restored.text
    enqueueReview(async () => {
      try {
        const result = await api.fsWrite(scope, path, writeText, mtimeRef.current)
        if (typeof result.mtimeMs === 'number') mtimeRef.current = result.mtimeMs
      } catch {
        setSaveState('failed')
        return
      }
      commit()
    })
  }

  // Publish the pending review into the CodeMirror document: red removed-line
  // blocks, green tints on the kept lines, and the per-hunk action bar. The
  // view outlives React renders; the effect only mutates its decorations.
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    if (review === null) {
      view.dispatch({ effects: setReviewDecorations.of(null) })
      return
    }
    view.dispatch({
      effects: setReviewDecorations.of({
        review,
        placements: walkReview(review).placements,
        active: activeHunkOf(review),
        dirty,
        onKeep: keepHunk,
        onReject: rejectHunk,
        onPrevious: () => { navigateReview('previous') },
        onNext: () => { navigateReview('next') },
        onKeepAll: keepAllHunks,
        onRejectAll: rejectAllHunks,
      }),
    })
    // The handlers close over live refs; their per-render identities would
    // re-dispatch this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, content, dirty])

  // Follow the action bar when it advances: put the caret on the new hunk and
  // scroll it into view (the Cursor-style "jump to the next diff").
  useEffect(() => {
    if (review === null) return
    const active = activeHunkOf(review)
    if (active === null) return
    const placement = walkReview(review).placements.get(active)
    const view = viewRef.current
    if (placement === undefined || view === null) return
    const lineNumber = Math.min(Math.max(placement.anchor + 1, 1), view.state.doc.lines)
    const target = view.state.doc.line(lineNumber).from
    view.dispatch({ selection: { anchor: target } })
    view.requestMeasure()
    requestAnimationFrame(() => {
      const block = view.lineBlockAt(target)
      view.scrollDOM.scrollTop = Math.max(0, block.top - 48)
      view.requestMeasure()
    })
  }, [review])

  // Ctrl/Cmd+K keeps the current hunk, Ctrl/Cmd+J rejects it, Ctrl+Alt+K/J
  // resolves every remaining hunk, Ctrl/Cmd+Z walks the last decision back.
  // Only while the editor (or a review bar) owns focus; the composer and
  // terminal keep their own keys. Ctrl+Z is not stolen from CodeMirror's own
  // text undo once the user has typed since the decision.
  useEffect(() => {
    if (review === null && reviewResult === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const active = document.activeElement
      const inActions = active instanceof Element && active.closest('[data-cursorlike-review-actions]') !== null
      const inEditor = viewRef.current?.hasFocus === true
      const inUndo = undoBarRef.current?.contains(active) === true
      if (!(inEditor || inActions || inUndo)) return
      if (key === 'z' && !event.shiftKey && !event.altKey) {
        if (reviewUndoRef.current.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        undoReviewStepAction()
        return
      }
      if (review === null) return
      if (event.altKey) {
        if (key === 'k') {
          event.preventDefault()
          event.stopPropagation()
          keepAllHunks()
        } else if (key === 'j') {
          event.preventDefault()
          event.stopPropagation()
          rejectAllHunks()
        }
        return
      }
      if (key === 'k') {
        event.preventDefault()
        event.stopPropagation()
        keepHunk()
      } else if (key === 'j') {
        event.preventDefault()
        event.stopPropagation()
        rejectHunk()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  })

  // Per-feature sandbox escape hatch: the global side card setting (warned)
  // plus a per-surface temporary unlock. The unlock state starts at the
  // "default unsafe" pref so a preview can open straight into the red
  // unsandboxed state (still restorable from the status row). With the
  // sandbox OFF the preview iframe drops its sandbox attribute entirely —
  // the previewed page then runs on the GUI's own origin with full session
  // access.
  const [localUnlock, setLocalUnlock] = useState(() => props.store?.getPrefs().htmlViewerDefaultUnsafe === true)
  const htmlNoSandbox = props.store?.getPrefs().htmlViewerNoSandbox === true || localUnlock

  // Host-toolbar mode (the merged editor header renders the controls): skip
  // the own toolbar row, report the state after every relevant render (the
  // JSON key guards redundant calls), and register the commands on mount.
  const hostToolbar = props.toolbar === 'host'
  const lastToolbarRef = useRef('')
  useEffect(() => {
    if (!hostToolbar) return
    const state: EditorToolbarState = { modes: toggleable, mode, dirty, editable, ...(readOnly ? { largeFile: true } : {}), saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  // Above the editable threshold there is no document to edit: the viewer is
  // the read-only paged preview and nothing else. Returning before the editor
  // subtree exists is deliberate — it is what guarantees no CodeMirror state
  // can be built for a file we never loaded.
  if (readOnly && largeFile !== undefined) {
    return (
      <LargeFileView
        scope={scope}
        path={path}
        size={largeFile.size}
        visible={props.visible !== false}
        revision={props.mtimeMs ?? 0}
      />
    )
  }

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {toggleable && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('searchFind')}
            title={`${t('searchFind')} (Ctrl/Cmd+F)`}
            onClick={() => {
              // The panel lives in the CodeMirror surface: in preview mode the
              // editor is hidden, so switch to edit first (the search panel is
              // not part of the preview).
              if (mode === 'preview' && (markdown || html || jsonl)) setMode('edit')
              const view = viewRef.current
              if (view === null) return
              view.focus()
              openSearchPanel(view)
            }}
          >
            <IconSearchOutlineRegular size={16} />
          </button>
        )}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutlineRegular />
          </button>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      )}
      {editable && (
        <>
          {conflict && (
            <div className={css.editorBanner}>
              {t('saveConflict')}
              <button
                type="button"
                className={css.editorBannerAction}
                onClick={() => { props.onReload?.() }}
              >
                {t('saveConflictReload')}
              </button>
            </div>
          )}
          <div
            className={clsx(css.editorCm, showingPreview && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {review !== null && showingPreview && (() => {
        const active = activeHunkOf(review)
        const summary = reviewSummary(review)
        const index = active === null ? 0 : review.hunks.findIndex(hunk => hunk.id === active) + 1
        return (
          <div className={css.editorReviewDock} role="status" aria-live="polite">
            <div className={css.editorReviewBar} data-cursorlike-review-actions="">
              <span className={css.editorReviewText}>
                {t('reviewHunkProgress', { index, total: summary.total, remaining: summary.pending })}
              </span>
              <button
                type="button"
                className={css.editorReviewNav}
                title={t('reviewPrevious')}
                aria-label={t('reviewPrevious')}
                onClick={() => { navigateReview('previous') }}
              >‹</button>
              <button
                type="button"
                className={css.editorReviewNav}
                title={t('reviewNext')}
                aria-label={t('reviewNext')}
                onClick={() => { navigateReview('next') }}
              >›</button>
              <button
                type="button"
                className={css.editorReviewKeep}
                onClick={() => { if (active !== null) keepHunk(active) }}
              >
                {t('reviewKeepHunk')} <kbd className={css.editorReviewKbd}>Ctrl+K</kbd>
              </button>
              <button
                type="button"
                className={css.editorReviewReject}
                onClick={() => { if (active !== null) rejectHunk(active) }}
                disabled={dirty}
                title={dirty ? t('unsaved') : undefined}
              >
                {t('reviewRejectHunk')} <kbd className={css.editorReviewKbd}>Ctrl+J</kbd>
              </button>
              <button type="button" className={css.editorReviewKeep} onClick={keepAllHunks}>
                {t('reviewKeepAll')} <kbd className={css.editorReviewKbd}>Ctrl+Alt+K</kbd>
              </button>
              <button
                type="button"
                className={css.editorReviewReject}
                onClick={rejectAllHunks}
                disabled={dirty}
                title={dirty ? t('unsaved') : undefined}
              >
                {t('reviewRejectAll')} <kbd className={css.editorReviewKbd}>Ctrl+Alt+J</kbd>
              </button>
            </div>
          </div>
        )
      })()}
      {reviewResult !== null && (
        <div className={css.editorReviewDock} ref={undoBarRef} role="status" aria-live="polite">
          <div className={css.editorReviewUndo}>
            <span>{reviewResult.kind === 'keep' ? t('reviewKept') : t('reviewRejected')}</span>
            <button
              type="button"
              className={css.editorReviewUndoButton}
              onClick={undoReviewStepAction}
              disabled={dirty || undoCount === 0}
              title={dirty ? t('unsaved') : undefined}
            >
              {t('reviewUndo')} <kbd className={css.editorReviewKbd}>Ctrl+Z</kbd>
            </button>
          </div>
        </div>
      )}
      {jsonl && mode === 'preview' && (
        <LargeFileView
          scope={scope}
          path={path}
          size={size ?? content?.length ?? 0}
          visible={props.visible !== false}
          revision={props.mtimeMs ?? 0}
        />
      )}
      {markdown && mode === 'preview' && (
        <div
          className={css.editorMd}
          ref={previewRef}
          onMouseUp={handlePreviewMouseUp}
          onDragStart={(event) => {
            const selection = window.getSelection()
            if (selection === null || selection.isCollapsed || selection.anchorNode === null || selection.focusNode === null) return
            if (mdRef.current === null || !mdRef.current.contains(selection.anchorNode) || !mdRef.current.contains(selection.focusNode)) return
            const text = selection.toString()
            if (text.trim() === '') return
            writeSelectionDrag(event.dataTransfer, scope.sessionId, {
              path,
              lines: linesOfSelection(mdText, text) ?? undefined,
            })
          }}
          onScroll={(event) => {
            const el = event.currentTarget
            if (!restoringRef.current && el.scrollHeight > el.clientHeight) {
              previewScrollRef.current = el.scrollTop
              rememberPreviewScroll(scope, path, el.scrollTop)
            }
            if (!anchorThrottleRef.current) {
              anchorThrottleRef.current = true
              setTimeout(() => { anchorThrottleRef.current = false }, 120)
              const ratio = el.scrollHeight > el.clientHeight
                ? el.scrollTop / (el.scrollHeight - el.clientHeight)
                : 0
              // The first block below the viewport's top edge, chosen with
              // layout coordinates (caretRangeFromPoint needs an in-viewport
              // point and returns null when the panel is partially off-screen).
              // Its text is the anchor the editor syncs to on preview -> edit.
              let text: string | null = null
              const base = el.getBoundingClientRect()
              const blocks = el.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li')
              for (const block of blocks) {
                if (block.getBoundingClientRect().top - base.top + el.scrollTop >= el.scrollTop - 2) {
                  const t = (block.textContent ?? '').replace(/[ \t\r\n]+/g, ' ').trim()
                  if (t.length >= 8) text = t
                  break
                }
              }
              previewSyncRef.current = { text, ratio }
            }
            selectionPopup.hide()
          }}
        >
          {/* The fence copy-button labels must come from this plugin's own
              dictionary: the DSH MarkdownText/CodeBlock are cordis-free and
              fall back to hardcoded Chinese otherwise (same pattern as the
              chat's AssistantMarkdown). Render-time t() keeps them following
              the active locale on live switches. Plain markdown (no HTML)
              renders exactly as before — one MarkdownText pass for the whole
              document, or the mermaid lazy chunk (single markdown parse;
              cross-fence references/footnotes stay intact) when a mermaid
              fence exists. Documents containing HTML (block runs or inline
              tags) render through the split document renderer: markdown runs
              keep the MarkdownText/mermaid path while raw-HTML runs render
              as sanitized DOM (see markdown-html.tsx). */}
          {/* The outline button rides on top of the preview scroll container
              (sticky, zero-height — first child so it pins from the very
              top) once the document has enough headings. */}
          <MdToc />
          {/* The host delegate makes the preview's local markdown links
              clickable at all (without it the renderer degrades them to plain
              text) and routes them through this surface's own open path. */}
          <MarkdownDelegateProvider openFile={openSurfaceFile}>
            {htmlInfo !== null
              ? <MarkdownDocument info={htmlInfo} media={htmlMedia} codeLabels={codeLabels} />
              : hasMermaid
                ? <LazyMermaidMarkdown text={previewText} codeLabels={codeLabels} />
                : <MarkdownText {...markdownTextProps(previewText, codeLabels)} />}
          </MarkdownDelegateProvider>
        </div>
      )}
      {html && mode === 'preview' && (
        <>
          <SandboxStatusBar
            sandboxed={!htmlNoSandbox}
            local={localUnlock}
            dangerCopy={t('htmlNoSandboxWarning')}
            onUnlock={() => { setLocalUnlock(true) }}
            onRestore={() => { setLocalUnlock(false) }}
          />
          {/* Route-src (never srcdoc — a srcdoc frame inherits the parent
              origin when unsandboxed; the route URL keeps the frame
              cross-origin by construction). The preview shows the SAVED
              file; the draft is only visible in edit mode. */}
          <iframe
            className={css.editorHtml}
            src={htmlUrl(scope, path)}
            sandbox={htmlNoSandbox ? undefined : HTML_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            title={path}
          />
        </>
      )}
      {selectionPopup.popup !== null && createPortal(
        <button
          type="button"
          ref={selectionPopup.buttonRef}
          draggable
          onDragStart={(event) => { selectionPopup.drag(event.dataTransfer) }}
          title={`Ctrl+L ${t('addToConversation')}`}
          aria-keyshortcuts="Control+L"
          className={css.selectionPopup}
          style={{ left: selectionPopup.popup.left, top: selectionPopup.popup.top }}
          // Keep the selection (and CodeMirror focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={selectionPopup.commit}
        >
          Ctrl+L {t('addToConversation')}
        </button>,
        document.body,
      )}
    </>
  )
}
