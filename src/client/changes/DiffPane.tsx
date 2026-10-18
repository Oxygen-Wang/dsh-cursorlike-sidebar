/**
 * The changes tab's shared bottom preview pane: one selected target — a git
 * worktree change, a commit patch, or a session file op — rendered through
 * the unified diff stack (the same one the diff tab uses). Git targets load
 * through the shared {@link useGitDiffTarget} hook (refreshable, with the
 * untracked full-addition fallback); op targets are pure snapshots. The pane
 * is resizable by drag (clamped; the height commits to the tab's persisted
 * meta on release) and by keyboard; git targets can expand into a dedicated
 * diff tab via the shell.
 *
 * The pane's views are TABS, one per question: `content` answers "what is in
 * the file" (every read op, and the rendered view for md/html/pdf ops — the
 * plugin's renderers no longer hide behind a toggle inside the diff view),
 * `diff` answers "what changed" (git targets, write/edit ops), and extra
 * views the caller hosts (the graph commit's `details` card) sit ahead of
 * both. A read op has no `diff` tab — nothing changed. With one or zero tabs
 * the pane is byte-for-byte the strip-less preview of before.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconCloseOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { SessionScope } from '../api.ts'
import { api, htmlUrl } from '../api.ts'
import { hostTransportBase } from '../desktop-env.ts'
import { t } from '../locales.ts'
import { baseName } from '../paths.ts'
import { resolveSidebarPath } from '../paths.ts'
import { HTML_IFRAME_SANDBOX } from '../html-preview.ts'
import type { SidebarDiffRef, SidebarTab } from '../state.ts'
import { DiffRows, ReadRows } from '../diff/DiffRows.tsx'
import { PdfView } from '../PdfView.tsx'
import { BinaryDownload } from '../binary-download.tsx'
import { DiffFiles } from '../diff/DiffFiles.tsx'
import { langOfPath } from '../diff/highlight.ts'
import { buildDiffSegments, diffLines, diffStats, parseUnifiedDiff, unifiedSegments, type DiffRow } from '../diff/rows.ts'
import {
  activeHunkOf,
  buildPendingReview,
  keepAllReviewHunks,
  keepReviewHunk,
  nextPending,
  previousPending,
  rejectAllPendingHunks,
  rejectReviewHunk,
  REVIEW_UNDO_LIMIT,
  reviewSummary,
  reviewText,
  undoReviewStep,
  type PendingReview,
  type ReviewStep,
  type ReviewUndo,
} from '../diff/review-model.ts'
import { reviewBasisOf, sameText } from './op-review.ts'
import { loadDiffReview, saveDiffReview } from '../diff/review-storage.ts'
import { WorktreeReview } from '../diff/WorktreeReview.tsx'
import { useGitDiffTarget } from '../diff/use-git-diff.ts'
import { parseReadContent, parseReadLines, type FileOp } from './ops.ts'
import { redactText } from '../redact.ts'
import { rewriteLocalImageUrls } from '../markdown-images.ts'
import { markdownTextProps } from '../markdown-labels.tsx'
import { useMarkdownSurface } from '../use-markdown-surface.ts'
import { splitMermaidBlocks } from '../mermaid-blocks.ts'
import { LazyMermaidMarkdown } from '../mermaid-lazy.tsx'
import { createFrameBatcher } from '../frame-batcher.ts'
import { Chip, IconButton, Notice, StatusBadge } from '../ui/index.ts'
import css from './changes.module.css'
import diffCss from '../diff/diff.module.css'

/** Drag handle height clamp (px) and keyboard-resize step. */
const HEIGHT_MIN = 140
const HEIGHT_STEP = 24

/**
 * Clamp one pane height to the pane's own bounds: never below the content
 * minimum, never above 70% of the window. Both the drag handler and the
 * RESTORE path (a height persisted under a taller window) run through this,
 * so a saved value can never open the pane taller than the viewport allows.
 */
export function clampPaneHeight(value: number): number {
  return Math.min(Math.max(value, HEIGHT_MIN), Math.round(window.innerHeight * 0.7))
}

/** The redaction preference, persisted under the repo's sidebar storage
 *  prefix (see state.ts's `dsh-sidebar:v1`). */
const REDACTION_KEY = 'dsh-sidebar:v1:redaction'

/** What the pane is showing right now. */
export type ChangesPreview =
  | { kind: 'git'; ref: SidebarDiffRef }
  | { kind: 'op'; path: string; op: FileOp; prior?: string }

/** Diff material for one op snapshot: an edit reconstructs the full file
 *  from the window's known prior content when possible (hunk-style context);
 *  a write with unknown prior content renders all-added. */
function diffOf(op: FileOp, prior: string | undefined): readonly DiffRow[] {
  if (op.kind === 'read') return []
  if (op.kind === 'edit' && op.edit !== undefined) {
    const { oldString, newString } = op.edit
    if (prior !== undefined && prior.includes(oldString)) {
      const newFile = prior.replace(oldString, newString)
      return diffLines(prior, newFile)
    }
    return diffLines(oldString, newString)
  }
  if (op.kind === 'write') {
    const content = op.content ?? ''
    const old = prior !== undefined && prior !== content ? prior : undefined
    return diffLines(old ?? '', content)
  }
  return []
}

/** The render view of one html op target: the route-src iframe. Extracted
 *  (and exported) so the always-sandboxed contract is pinned directly by the
 *  sandbox spec — this surface has NO no-sandbox escape hatch. */
export function HtmlRenderPreview(props: { src: string; title: string }) {
  return (
    <div className={css.htmlPane}>
      <iframe
        className={css.htmlFrame}
        title={props.title}
        src={props.src}
        sandbox={HTML_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
      />
    </div>
  )
}

/** One header pill toggle — the redaction / reading / render toggles share the
 *  shape: the global {@link Chip} (its active state is the "on" picture). */
function PaneToggle(props: { on: boolean; label: string; title?: string; onClick: () => void }) {
  return <Chip active={props.on} title={props.title} onClick={props.onClick}>{props.label}</Chip>
}

/** The session-lens per-hunk review state (one op). */
interface OpReviewState {
  readonly review: PendingReview
  /** The disk mtime the review was verified against (updated by each write). */
  readonly mtime: number | null
  /** The file's bytes as this review last left them. */
  readonly diskText: string
  readonly undo: readonly { review: PendingReview; undo: ReviewUndo }[]
  readonly result: { kind: 'keep' | 'reject'; kept: number; rejected: number } | null
  readonly busy: boolean
  readonly error: string | null
}

/**
 * The in-diff action bar of one hunk: keep/revert THIS block (which advances
 * to the next one), navigate, or resolve everything at once. Reverting writes
 * the reconstruction straight to disk, which the bar's note says.
 */
function OpReviewBar(props: {
  state: OpReviewState
  onPrevious: () => void
  onNext: () => void
  onKeep: () => void
  onReject: () => void
  onKeepAll: () => void
  onRejectAll: () => void
}) {
  const { state } = props
  const summary = reviewSummary(state.review)
  const active = activeHunkOf(state.review)
  const index = active === null ? summary.total : state.review.hunks.findIndex(hunk => hunk.id === active) + 1
  return (
    <div className={css.reviewBar} data-changes-op-review="" role="group" aria-label={t('changesReview')}>
      <span className={css.reviewProgress} title={t('changesReviewWriteHint')}>
        {t('reviewHunkProgress', { index, total: summary.total, remaining: summary.pending })}
      </span>
      <button
        type="button"
        className={css.reviewNav}
        disabled={state.busy || summary.pending <= 1}
        title={t('reviewPrevious')}
        aria-label={t('reviewPrevious')}
        onClick={props.onPrevious}
      >‹</button>
      <button
        type="button"
        className={css.reviewNav}
        disabled={state.busy || summary.pending <= 1}
        title={t('reviewNext')}
        aria-label={t('reviewNext')}
        onClick={props.onNext}
      >›</button>
      <button
        type="button"
        className={css.reviewKeep}
        disabled={state.busy || active === null}
        onClick={props.onKeep}
      >
        {t('reviewKeepHunk')} <kbd className={css.reviewKbd}>Ctrl+K</kbd>
      </button>
      <button
        type="button"
        className={css.reviewReject}
        disabled={state.busy || active === null}
        onClick={props.onReject}
      >
        {t('reviewRejectHunk')} <kbd className={css.reviewKbd}>Ctrl+J</kbd>
      </button>
      <button
        type="button"
        className={css.reviewKeep}
        disabled={state.busy || summary.pending === 0}
        onClick={props.onKeepAll}
      >
        {t('reviewKeepAll')} <kbd className={css.reviewKbd}>Ctrl+Alt+K</kbd>
      </button>
      <button
        type="button"
        className={css.reviewReject}
        disabled={state.busy || summary.pending === 0}
        onClick={props.onRejectAll}
      >
        {t('reviewRejectAll')} <kbd className={css.reviewKbd}>Ctrl+Alt+J</kbd>
      </button>
    </div>
  )
}

/** One tab of the pane's optional strip. */
export interface PaneTab {
  readonly id: string
  readonly label: string
}

/**
 * A compact tab strip — a real tablist with roving focus: the active tab is
 * the only tab stop, and Left/Right/Home/End move focus AND selection (the
 * standard automatic-activation model). Born as the bottom pane's strip
 * (details / diff); the changes tab's header reuses it for the lens switcher
 * so the page's two switchers read as one component. Rendered only when the
 * caller hosts more than one view, so a diff-only preview never grows a strip.
 */
export function PaneTabStrip(props: { tabs: readonly PaneTab[]; active: string; onSelect(id: string): void; className?: string; label?: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const move = (to: number): void => {
    const count = props.tabs.length
    if (count === 0) return
    const index = ((to % count) + count) % count
    props.onSelect(props.tabs[index]!.id)
    buttons.current[index]?.focus()
  }
  return (
    <div className={props.className === undefined ? css.paneTabs : `${css.paneTabs} ${props.className}`}
      role="tablist" aria-label={props.label}>
      {props.tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => { buttons.current[index] = node }}
          type="button"
          role="tab"
          className={css.paneTab}
          data-active={tab.id === props.active ? 'true' : undefined}
          aria-selected={tab.id === props.active}
          tabIndex={tab.id === props.active ? 0 : -1}
          onClick={() => { props.onSelect(tab.id) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); move(index + 1) }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); move(index - 1) }
            else if (event.key === 'Home') { event.preventDefault(); move(0) }
            else if (event.key === 'End') { event.preventDefault(); move(props.tabs.length - 1) }
          }}
        >{tab.label}</button>
      ))}
    </div>
  )
}

/** The reading-mode body of one markdown op target: the shared MarkdownText
 *  pass (local image destinations already rewritten to the media route by
 *  the caller). Mermaid fences render through the same chunk-resident
 *  renderer the editor preview uses (one MarkdownText pass with the fences
 *  lifted out); the plain path stays byte-for-byte for documents without
 *  any.
 *
 *  The body is also a markdown SURFACE: heading slugs, anchor jumps and `.md`
 *  link claiming, with relative targets resolved against the previewed file's
 *  own directory (see use-markdown-surface). */
function MdReadingView(props: { text: string; ctx: Context; scope: SessionScope; path: string }) {
  const codeLabels = {
    copyLabel: t('copy'),
    copiedLabel: t('copied'),
    codeLabel: t('codeBlockTitle'),
    wrapLabel: t('codeBlockWrap'),
    unwrapLabel: t('codeBlockUnwrap'),
  }
  const surface = useMarkdownSurface({
    ctx: props.ctx,
    sessionId: props.scope.sessionId,
    cwd: props.scope.cwd,
    path: props.path,
  })
  // The caller already rewrote local IMAGE destinations; this pass is the link
  // half (and is idempotent, so the two can be composed in either order).
  const text = surface.rewrite(props.text)
  const hasMermaid = splitMermaidBlocks(text).some((block) => block.kind === 'mermaid')
  return (
    <div className={css.paneBody} ref={surface.surfaceRef}>
      <div className={css.mdBody}>
        <MarkdownDelegateProvider openFile={surface.openFile}>
          {hasMermaid
            ? <LazyMermaidMarkdown text={text} codeLabels={codeLabels} />
            : <MarkdownText {...markdownTextProps(text, codeLabels)} />}
        </MarkdownDelegateProvider>
      </div>
    </div>
  )
}

/** The diff tab a git preview expands into (the shell owns placement). */
export function diffTabOf(ref: SidebarDiffRef): SidebarTab {
  if (ref.kind === 'worktree') {
    return {
      id: `diff:w:${encodeURIComponent(ref.worktree ?? '')}:${ref.staged ? 's' : 'u'}:${ref.path}`,
      type: 'diff',
      title: baseName(ref.path),
      diff: ref,
    }
  }
  return {
    id: `diff:c:${encodeURIComponent(ref.worktree ?? '')}:${ref.hashFull}`,
    type: 'diff',
    title: `${ref.hash} ${ref.subject}`,
    diff: ref,
  }
}

export interface DiffPaneProps {
  /** Fill a dedicated diff tab; omit preview resize/close controls. */
  fill?: boolean
  target: ChangesPreview
  ctx: Context
  scope: SessionScope
  /** The persisted pane height (px); drag commits a new one upwards. */
  height: number
  onHeightCommit: (height: number) => void
  onClose: () => void
  /** Expand the current git target into a dedicated diff tab. */
  onExpand: () => void
  /** The pane's views. The host may PIN the set (the changes tab pins
   *  details/content/diff so the panel is identical in every lens; a pinned
   *  id with nothing to show renders its empty state instead of vanishing).
   *  Omitted, the set is composed from what this target actually offers. */
  tabs?: readonly PaneTab[]
  /** Bodies for ids the pane does not build itself (the caller's views). */
  bodies?: Readonly<Record<string, ReactNode>>
  /** The active tab id; an id not listed lands on the built-in home. */
  activeTab?: string
  onSelectTab?(id: string): void
  /** Whether this pane is on screen (a parked tab body stays mounted). The
   *  per-hunk review's shortcuts are gated on it. */
  visible?: boolean
  /** Called once an op's review resolves every line: the caller advances the
   *  queue to the next changed file. */
  onReviewComplete?: (callId: string) => void
}

/** One tab's "nothing here" body — a page-level empty notice. */
function PaneEmpty({ text }: { text: string }) {
  return <div className={css.paneBody}><Notice kind="empty" tone="page">{text}</Notice></div>
}

export function DiffPane({ target, ctx, scope, height, onHeightCommit, onClose, onExpand, tabs, bodies, activeTab, onSelectTab, visible = true, onReviewComplete, fill = false }: DiffPaneProps) {
  // ── Git target loading (the shared loader: staged-side fallback, the
  //    untracked full-addition fallback, refresh by tick, fold cache). ─────
  const gitRef = target.kind === 'git' ? target.ref : null
  /** The git target when it is a WORKTREE file (the only git target with a
   *  content view, and the only one carrying a `path`). */
  const gitWorktree = gitRef !== null && gitRef.kind === 'worktree' ? gitRef : null
  const { loading, error, diffText, untracked, refresh, resolveFold, effectiveStaged } = useGitDiffTarget(gitRef, scope)

  // ── The pane's views, resolved BEFORE anything loads: which tabs exist and
  //    which one is on screen. Computed from raw target facts (`kind` and
  //    `isError` do not change under redaction), so the loaders below can
  //    defer their work for views that are not on screen. ──────────────────
  /** The path the content view is about: a worktree file's, or an op's. */
  const targetPath = gitWorktree !== null ? gitWorktree.path : target.kind === 'op' ? target.path : ''
  /** A target whose content view may RENDER: a non-error op, or a worktree
   *  file (the plugin's renderers are the reason the content tab exists). */
  const renderable = (target.kind === 'op' && !target.op.isError) || gitWorktree !== null
  const mdOp = renderable && /\.(md|markdown|mdx)$/i.test(targetPath)
  const htmlOp = renderable && /\.(html?)$/i.test(targetPath)
  const pdfOp = renderable && /\.pdf$/i.test(targetPath)
  /** Source vs rendered inside the CONTENT tab. Markdown starts rendered (the
   *  sanitized MarkdownText is the point of the tab); html starts on SOURCE —
   *  selecting a row must never auto-load an iframe without an explicit click
   *  (the sandbox spec pins this). */
  const [contentRaw, setContentRaw] = useState(htmlOp)
  const opKind = target.kind === 'op' ? target.op.kind : null
  const opError = target.kind === 'op' && target.op.isError
  /** What this target can offer: every read op has a content view, md/html/pdf
   *  ops have one whatever they did, and a git WORKTREE file has one too (the
   *  file itself, next to its patch). */
  const hasContentTab = target.kind === 'git'
    ? target.ref.kind === 'worktree'
    : opKind !== null && !opError && (opKind === 'read' || mdOp || htmlOp || pdfOp)
  const hasDiffTab = target.kind === 'git' || (opKind !== null && (opKind !== 'read' || opError))
  /** The host may PIN the tab set (the changes tab pins details/content/diff
   *  so the panel is identical in every lens); otherwise the set is composed
   *  from what this target offers. An unlisted / absent active id lands on the
   *  built-in home (`diff`, else `content`, else the first pinned view). */
  const allTabs: PaneTab[] = tabs !== undefined
    ? [...tabs]
    : [
      ...(hasContentTab ? [{ id: 'content', label: t('changesContentTab') }] : []),
      ...(hasDiffTab ? [{ id: 'diff', label: t('changesDiffTab') }] : []),
    ]
  const hasStrip = allTabs.length > 1
  const active = activeTab !== undefined && allTabs.some(tab => tab.id === activeTab)
    ? activeTab
    : hasDiffTab ? 'diff' : hasContentTab ? 'content' : allTabs[0]?.id ?? 'diff'
  const activeExtra = active !== 'diff' && active !== 'content'

  // ── The `content` tab of a GIT target: the worktree file itself (the diff
  //    tab answers "what changed"; this one answers "what is in it"). Loaded
  //    lazily — only while the content view is actually on screen — through
  //    the same `fs.read` the editor uses, with the same path resolution the
  //    diff loader applies to a worktree file. ──────────────────────────────
  const [gitContent, setGitContent] = useState<
    { status: 'idle' | 'loading' | 'binary' | 'large' } | { status: 'text'; text: string } | { status: 'error'; error: string }
  >({ status: 'idle' })
  useEffect(() => {
    if (gitWorktree === null) { setGitContent({ status: 'idle' }); return }
    // Deferred until the content view is the one on screen: opening a file to
    // read its DIFF must not pull the whole document.
    if (active !== 'content') return
    const controller = new AbortController()
    setGitContent({ status: 'loading' })
    api.fsRead(scope, resolveSidebarPath(gitWorktree.repoRoot ?? gitWorktree.worktree ?? scope.cwd, gitWorktree.path), controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.kind === 'text') setGitContent({ status: 'text', text: result.content })
        else if (result.kind === 'binary') setGitContent({ status: 'binary' })
        else setGitContent({ status: 'large' })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setGitContent({ status: 'error', error: reason instanceof Error ? reason.message : String(reason) })
      })
    return () => { controller.abort() }
  }, [gitWorktree, scope, active])

  // ── Op target material (pure snapshots; the prior content came with the
  //    target so a running op shows what is already known). ────────────────
  const opRaw = target.kind === 'op' ? target.op : null
  const priorRaw = target.kind === 'op' ? target.prior : undefined
  // Secret redaction: on by default, toggle persists per browser (localStorage).
  // Every op payload consumer below (diff rows, read rows, markdown source,
  // error text) renders from the REDACTED shape, so masked payloads are the
  // only thing that can reach the DOM while the toggle is on. Display-only:
  // session events and the fs layer keep their original bytes.
  const [redactionOn, setRedactionOn] = useState((): boolean => {
    try { return localStorage.getItem(REDACTION_KEY) !== '0' } catch { return true }
  })
  const toggleRedaction = (): void => {
    setRedactionOn((prev) => {
      const next = !prev
      try { localStorage.setItem(REDACTION_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  }
  const { op, prior, redactionHit } = useMemo(() => {
    if (opRaw === null || !redactionOn) return { op: opRaw, prior: priorRaw, redactionHit: false }
    const path = target.kind === 'op' ? target.path : ''
    // One redactText pass per field: the outcome carries both the masked
    // text and whether anything was hit.
    const mask = (text: string | undefined): { masked: string | undefined; hit: boolean } => {
      if (text === undefined) return { masked: undefined, hit: false }
      const outcome = redactText(path, text)
      return { masked: outcome.text, hit: outcome.hit }
    }
    const read = mask(opRaw.read)
    const content = mask(opRaw.content)
    const editOld = mask(opRaw.edit?.oldString)
    const editNew = mask(opRaw.edit?.newString)
    const errorText = mask(opRaw.errorText)
    const priorMasked = mask(priorRaw)
    const hit = read.hit || content.hit || editOld.hit || editNew.hit || errorText.hit || priorMasked.hit
    if (!hit) return { op: opRaw, prior: priorRaw, redactionHit: false }
    const redacted: FileOp = {
      ...opRaw,
      ...(read.masked !== undefined ? { read: read.masked } : {}),
      ...(content.masked !== undefined ? { content: content.masked } : {}),
      ...(opRaw.edit !== undefined
        ? { edit: { oldString: editOld.masked ?? opRaw.edit.oldString, newString: editNew.masked ?? opRaw.edit.newString } }
        : {}),
      ...(errorText.masked !== undefined ? { errorText: errorText.masked } : {}),
    }
    return { op: redacted, prior: priorMasked.masked, redactionHit: true }
  }, [opRaw, priorRaw, target, redactionOn])
  const opLang = useMemo(() => (target.kind === 'op' ? langOfPath(target.path) : undefined), [target])
  const opReadLines = useMemo(
    () => (op?.kind === 'read' && op.read !== undefined ? parseReadLines(op.read) : []),
    [op],
  )

  // ── Per-hunk review of a session op (the changes page's "confirm/reject
  //    these changes"). Only a full-document basis can be written back, and
  //    only while the file still holds exactly the op's result; everything
  //    else keeps the read-only diff. ────────────────────────────────────────
  const opAbsPath = target.kind === 'op' ? resolveSidebarPath(scope.cwd, target.path) : ''
  const reviewIdentity = target.kind === 'op' ? `${opAbsPath}:${target.op.callId}` : ''
  // A stable identity for "the same op content". The session poll re-folds its
  // op array on every event, giving `target` a new object identity even when
  // nothing about this op changed; keying the load effect on the object would
  // then reset an in-progress review on every unrelated event. Include the
  // entire payload so equal-length edits cannot share an identity.
  const reviewSourceKey = target.kind === 'op'
    ? JSON.stringify([
      target.op.callId,
      target.op.running ? 1 : 0,
      target.op.isError ? 1 : 0,
      target.op.edit?.oldString,
      target.op.edit?.newString,
      target.op.content,
      target.prior,
      target.path,
    ])
    : ''
  const [opReview, setOpReview] = useState<OpReviewState | null>(null)
  const opReviewRef = useRef<OpReviewState | null>(null)
  /** The review whose completion already advanced the queue (restored,
   *  already-decided reviews must not jump again on mount). */
  const jumpedRef = useRef<PendingReview | null>(null)
  const reviewOwnerRef = useRef({ source: reviewSourceKey, sessionId: scope.sessionId, cwd: scope.cwd })
  if (reviewOwnerRef.current.source !== reviewSourceKey || reviewOwnerRef.current.sessionId !== scope.sessionId || reviewOwnerRef.current.cwd !== scope.cwd) {
    reviewOwnerRef.current = { source: reviewSourceKey, sessionId: scope.sessionId, cwd: scope.cwd }
  }
  opReviewRef.current = opReview
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const opBodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    opReviewRef.current = null
    setOpReview(null)
    setReviewNotice(null)
    if (target.kind !== 'op' || target.op.isError) return
    // The row's bytes are masked while redaction is on; deciding a block from
    // masked text would write the mask back. The plain diff stays available.
    if (redactionHit) {
      setReviewNotice(t('changesReviewUnavailable'))
      return
    }
    const knownBasis = reviewBasisOf(target.op, target.prior)
    let cancelled = false
    api.fsRead(scope, opAbsPath).then((result) => {
      if (cancelled) return
      if (result.kind !== 'text') {
        setReviewNotice(t('changesReviewUnavailable'))
        return
      }
      let stored = loadDiffReview(scope.sessionId, reviewIdentity, opAbsPath, result.content)
      if (stored?.splitLines === true) stored = buildPendingReview(stored.base, result.content, opAbsPath)
      // An edit without a preceding read can still be reconstructed from its
      // unique replacement in the full live file. Never write a fragment.
      let basis = knownBasis
      const edit = target.op.edit
      if (basis === null && edit !== undefined && edit.newString !== '') {
        const at = result.content.indexOf(edit.newString)
        if (at !== -1 && result.content.indexOf(edit.newString, at + 1) === -1) {
          basis = { base: result.content.slice(0, at) + edit.oldString + result.content.slice(at + edit.newString.length), target: result.content }
        }
      }
      if (stored === null && basis === null) {
        setReviewNotice(t('changesReviewNoPrior'))
        return
      }
      const baseText = stored?.base ?? basis!.base
      const targetText = stored?.target ?? basis!.target
      if (redactionOn && (redactText(opAbsPath, baseText).hit || redactText(opAbsPath, targetText).hit)) {
        setReviewNotice(t('changesReviewUnavailable'))
        return
      }
      // A file that no longer holds the op's result has another revision on
      // disk: writing a reconstruction back would clobber it.
      if (stored === null && basis !== null && !sameText(result.content, basis.target)) {
        setReviewNotice(t('changesReviewDiskChanged'))
        return
      }
      const review = stored ?? buildPendingReview(basis!.base, basis!.target, opAbsPath)
      if (review.hunks.length === 0) return
      const summary = reviewSummary(review)
      const savedResult = review.decided
        ? {
          kind: (summary.rejected > 0 ? 'reject' : 'keep') as 'keep' | 'reject',
          kept: summary.kept,
          rejected: summary.rejected,
        }
        : null
      // A restored review that was already fully resolved keeps its result bar
      // but must not advance the queue on mount: the reader picked this file.
      jumpedRef.current = review.decided ? review : null
      const state: OpReviewState = {
        review,
        mtime: typeof result.mtimeMs === 'number' ? result.mtimeMs : null,
        diskText: result.content,
        undo: [],
        result: savedResult,
        busy: false,
        error: null,
      }
      opReviewRef.current = state
      saveDiffReview(scope.sessionId, reviewIdentity, review)
      setOpReview(state)
    }).catch(() => {
      if (!cancelled) setReviewNotice(t('changesReviewUnavailable'))
    })
    return () => { cancelled = true }
    // `reviewSourceKey` stands in for the op's target: a new op (or changed
    // payload) reloads, an unrelated poll re-fold does not. The scope object's
    // identity churns too; only its sessionId / cwd gate the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewSourceKey, redactionHit, opAbsPath, scope.sessionId, scope.cwd])

  /** Publish one applied step, its document text and the write's new mtime. */
  const commitOpReview = (step: ReviewStep, diskText: string, mtime?: number): void => {
    // Apply eagerly (ref + state) so two quick clicks each build on the
    // previous decision instead of both reading a stale ref.
    const previous = opReviewRef.current
    if (previous === null) return
    const undo = [...previous.undo, { review: step.review, undo: step.undo }].slice(-REVIEW_UNDO_LIMIT)
    const summary = reviewSummary(step.review)
    const result = step.review.decided
      ? {
        kind: (summary.rejected > 0 ? 'reject' : 'keep') as 'keep' | 'reject',
        kept: summary.kept,
        rejected: summary.rejected,
      }
      : null
    const next: OpReviewState = {
      ...previous,
      review: step.review,
      diskText,
      undo,
      result,
      busy: false,
      error: null,
      mtime: mtime ?? previous.mtime,
    }
    opReviewRef.current = next
    saveDiffReview(scope.sessionId, reviewIdentity, step.review)
    setOpReview(next)
  }

  /** Apply one step: write the reconstruction when it differs from the disk. */
  const runOpStep = async (step: ReviewStep, text: string): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    const owner = reviewOwnerRef.current
    if (text === state.diskText) {
      commitOpReview(step, state.diskText)
      return
    }
    const locked = { ...state, busy: true, error: null }
    opReviewRef.current = locked
    setOpReview(locked)
    try {
      if (state.mtime === null) throw new Error(t('changesReviewUnavailable'))
      const result = await api.fsWrite(scope, opAbsPath, text, state.mtime)
      saveDiffReview(scope.sessionId, reviewIdentity, step.review)
      if (reviewOwnerRef.current !== owner) return
      commitOpReview(step, text, typeof result.mtimeMs === 'number' ? result.mtimeMs : undefined)
    } catch (error) {
      if (reviewOwnerRef.current !== owner) return
      setOpReview(previous => previous === null ? previous : {
        ...previous,
        busy: false,
        error: error instanceof Error ? error.message : t('saveFailed'),
      })
    }
  }

  /** Keep one line: only its decision changes unless earlier lines were reverted. */
  const keepOpHunk = async (id?: number): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    const active = activeHunkOf(state.review)
    const targetId = id ?? active
    if (targetId === null) return
    const step = keepReviewHunk(state.review, targetId)
    if (step.review === state.review) return
    await runOpStep(step, reviewText(step.review))
  }

  /** Revert one line: its old side goes back into the reconstruction. */
  const rejectOpHunk = async (id?: number): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    const active = activeHunkOf(state.review)
    const targetId = id ?? active
    if (targetId === null) return
    const step = rejectReviewHunk(state.review, targetId)
    if (step.review === state.review) return
    await runOpStep(step, step.text ?? reviewText(step.review))
  }

  const keepAllOpHunks = async (): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    if (!state.review.hunks.some(hunk => hunk.decision === 'pending')) return
    const step = keepAllReviewHunks(state.review)
    await runOpStep(step, reviewText(step.review))
  }

  const rejectAllOpHunks = async (): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    if (!state.review.hunks.some(hunk => hunk.decision === 'pending')) return
    const step = rejectAllPendingHunks(state.review)
    if (step.text === null) return
    await runOpStep(step, step.text)
  }

  const navigateOpReview = (direction: 'next' | 'previous'): void => {
    const state = opReviewRef.current
    if (state === null) return
    const active = activeHunkOf(state.review)
    if (active === null) return
    const targetId = direction === 'next'
      ? nextPending(active, state.review.hunks)
      : previousPending(active, state.review.hunks)
    if (targetId === null || targetId === active) return
    const next: OpReviewState = { ...state, review: { ...state.review, active: targetId } }
    opReviewRef.current = next
    setOpReview(next)
  }

  const undoOpReview = async (): Promise<void> => {
    const state = opReviewRef.current
    if (state === null || state.busy) return
    const owner = reviewOwnerRef.current
    const entry = state.undo[state.undo.length - 1]
    if (entry === undefined) return
    const restored = undoReviewStep(entry.review, entry.undo)
    const text = restored.text ?? reviewText(restored.review)
    const apply = (mtime?: number): void => {
      const previous = opReviewRef.current
      if (previous === null) return
      const undo = previous.undo.slice(0, -1)
      const next: OpReviewState = {
        ...previous,
        review: restored.review,
        diskText: text,
        undo,
        result: null,
        busy: false,
        error: null,
        mtime: mtime ?? previous.mtime,
      }
      opReviewRef.current = next
      saveDiffReview(scope.sessionId, reviewIdentity, restored.review)
      setOpReview(next)
    }
    if (text === state.diskText) {
      apply()
      return
    }
    const locked = { ...state, busy: true, error: null }
    opReviewRef.current = locked
    setOpReview(locked)
    try {
      if (state.mtime === null) throw new Error(t('changesReviewUnavailable'))
      const result = await api.fsWrite(scope, opAbsPath, text, state.mtime)
      saveDiffReview(scope.sessionId, reviewIdentity, restored.review)
      if (reviewOwnerRef.current !== owner) return
      apply(typeof result.mtimeMs === 'number' ? result.mtimeMs : undefined)
    } catch (error) {
      if (reviewOwnerRef.current !== owner) return
      setOpReview(previous => previous === null ? previous : {
        ...previous,
        busy: false,
        error: error instanceof Error ? error.message : t('saveFailed'),
      })
    }
  }

  // Ctrl/Cmd+K/J decide the active hunk, Ctrl+Alt+K/J resolve all of them,
  // Ctrl/Cmd+Z walks the last decision back. Active only while this pane is
  // on screen and focus is not in a text field (the composer keeps its keys).
  useEffect(() => {
    if (!visible || opReview === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (!(event.ctrlKey || event.metaKey)) return
      const focused = document.activeElement
      if (!(focused instanceof Element)) return
      // Scope the review keys to the changes tab (its list or this pane): a
      // reader typing in the conversation must keep every shortcut.
      const pane = opBodyRef.current?.closest('[data-diff-pane]')
      const changes = pane?.closest('[data-changes-tab]')
      if (!pane?.contains(focused) && (changes == null || !changes.contains(focused) || focused.closest('[data-diff-pane]') !== null)) return
      if (focused instanceof HTMLElement && focused.closest('input, textarea, [contenteditable="true"]') !== null) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey && !event.altKey) {
        if (opReviewRef.current === null || opReviewRef.current.undo.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        void undoOpReview()
        return
      }
      if (event.altKey) {
        if (key === 'k') {
          event.preventDefault()
          event.stopPropagation()
          void keepAllOpHunks()
        } else if (key === 'j') {
          event.preventDefault()
          event.stopPropagation()
          void rejectAllOpHunks()
        }
        return
      }
      if (key === 'k') {
        event.preventDefault()
        event.stopPropagation()
        void keepOpHunk()
      } else if (key === 'j') {
        event.preventDefault()
        event.stopPropagation()
        void rejectOpHunk()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  })

  // Follow the bar when it advances: bring the new hunk into view.
  const reviewActive = opReview === null ? null : activeHunkOf(opReview.review)
  useEffect(() => {
    if (reviewActive === null) return
    const host = opBodyRef.current
    if (host === null) return
    const row = host.querySelector<HTMLElement>(`[data-review-hunk="${reviewActive}"][data-review-active="true"]`)
    row?.scrollIntoView?.({ block: 'center' })
  }, [reviewActive, opReview?.review])

  // When every line is resolved, hand the queue back to the changes tab so it
  // can move to the next changed file (the "jump to the next diff" step).
  useEffect(() => {
    if (opReview?.result == null || target.kind !== 'op') return
    if (jumpedRef.current === opReview.review) return
    jumpedRef.current = opReview.review
    onReviewComplete?.(target.op.callId)
    // Fire once per resolved review (the result object is stable until the
    // next action), and read the latest callback through the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opReview?.result])

  const reviewBase = opReview?.review.base
  const reviewTarget = opReview?.review.target
  const opRows = useMemo(() => reviewBase !== undefined && reviewTarget !== undefined && !redactionHit
    ? diffLines(reviewBase, reviewTarget)
    : op === null ? [] : diffOf(op, prior), [reviewBase, reviewTarget, redactionHit, op, prior])
  const opSegments = useMemo(() => buildDiffSegments(opRows), [opRows])
  const opStats = useMemo(() => diffStats(opSegments), [opSegments])
  const opRowIndex = useMemo(
    () => new Map(opRows.map((row, index) => [row, index])),
    [opRows],
  )
  const opReviewOverlay = useMemo(() => {
    if (opReview === null) return undefined
    const hunkOfRow = new Map<number, number>()
    const decisionOfHunk = new Map<number, 'pending' | 'keep' | 'reject'>()
    const hunkTail = new Map<number, number>()
    for (const hunk of opReview.review.hunks) {
      decisionOfHunk.set(hunk.id, hunk.decision)
      for (const row of hunk.rows) hunkOfRow.set(row, hunk.id)
      hunkTail.set(hunk.id, hunk.rowEnd)
    }
    const active = activeHunkOf(opReview.review)
    const activeHunk = active === null ? undefined : opReview.review.hunks.find(hunk => hunk.id === active)
    return {
      rowIndex: opRowIndex,
      hunkOfRow,
      decisionOfHunk,
      hunkTail,
      active,
      activeEnd: activeHunk?.rowEnd ?? null,
      rowActions: (hunkId: number) => {
        const decision = decisionOfHunk.get(hunkId) ?? 'pending'
        return (
          <>
            <button
              type="button"
              className={css.lineAction}
              data-action="keep"
              data-current={decision === 'keep' ? 'true' : undefined}
              disabled={opReview.busy}
              title={t('reviewKeepHunk')}
              aria-label={t('reviewKeepHunk')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void keepOpHunk(hunkId)
              }}
            >✓</button>
            <button
              type="button"
              className={css.lineAction}
              data-action="reject"
              data-current={decision === 'reject' ? 'true' : undefined}
              disabled={opReview.busy}
              title={t('reviewRejectHunk')}
              aria-label={t('reviewRejectHunk')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void rejectOpHunk(hunkId)
              }}
            >✕</button>
          </>
        )
      },
      bar: (
        <OpReviewBar
          state={opReview}
          onPrevious={() => { navigateOpReview('previous') }}
          onNext={() => { navigateOpReview('next') }}
          onKeep={() => { void keepOpHunk() }}
          onReject={() => { void rejectOpHunk() }}
          onKeepAll={() => { void keepAllOpHunks() }}
          onRejectAll={() => { void rejectAllOpHunks() }}
        />
      ),
    }
    // The handlers read `opReviewRef`, so the overlay only needs to rebuild
    // when the review state itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opReview, opRowIndex])

  // ── Content tab material: the file's full text, its source lines and the
  //    rendered variants (the tab set itself was resolved at the top). ──────
  /** The textual source behind the content view — the op's snapshot for op
   *  targets, the file on disk for a git worktree file. */
  const contentSrc = useMemo(() => {
    if (gitWorktree !== null) return gitContent.status === 'text' ? gitContent.text : ''
    if (target.kind !== 'op' || op === null) return ''
    if (op.kind === 'read') return parseReadContent(op.read ?? '')
    if (op.kind === 'write') return op.content ?? ''
    if (op.kind === 'edit' && op.edit !== undefined) {
      if (prior !== undefined && prior.includes(op.edit.oldString)) {
        return prior.replace(op.edit.oldString, op.edit.newString)
      }
      return op.edit.newString
    }
    return ''
  }, [gitWorktree, target.kind, op, prior, gitContent])
  /** The display path (for the language highlighter) and the resolved path the
   *  media/html routes need — a child-repo path is relative to its repo root,
   *  exactly as the diff loader resolves it. */
  const contentPath = targetPath
  const contentAbs = useMemo(
    () => (gitWorktree !== null
      ? resolveSidebarPath(gitWorktree.repoRoot ?? gitWorktree.worktree ?? scope.cwd, gitWorktree.path)
      : resolveSidebarPath(scope.cwd, contentPath)),
    [gitWorktree, scope, contentPath],
  )
  /** Source lines: a read keeps its ORIGINAL numbering (`opReadLines`), a
   *  whole-file source is renumbered from 1. */
  const contentLines = useMemo(
    () => (contentSrc === '' ? [] : contentSrc.split('\n').map((text, index) => ({ line: index + 1, text }))),
    [contentSrc],
  )
  const contentText = useMemo(
    () => (mdOp && !contentRaw && contentSrc !== ''
      ? rewriteLocalImageUrls(contentSrc, scope, contentPath, hostTransportBase())
      : ''),
    [mdOp, contentRaw, contentSrc, scope, contentPath],
  )
  const htmlRenderSrc = useMemo(
    () => (htmlOp && contentAbs !== '' ? htmlUrl(scope, contentAbs) : ''),
    [htmlOp, scope, contentAbs],
  )

  // Header stats for git targets come off the parsed patch text.
  const gitStats = useMemo(() => {
    if (target.kind !== 'git' || diffText === null || diffText === '') return null
    let added = 0
    let deleted = 0
    for (const file of parseUnifiedDiff(diffText).files) {
      const stats = diffStats(unifiedSegments(file))
      added += stats.added
      deleted += stats.deleted
    }
    return { added, deleted }
  }, [target, diffText])

  // ── Resize: drag the top handle; commit on release (persisted by the
  //    shell). Arrow keys resize by a step for keyboard users. ────────────
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const paneHeight = dragHeight ?? height
  const clamp = clampPaneHeight
  const dragOrigin = useRef<{ y: number; h: number } | null>(null)
  // Pointer streams fire several times per frame; one setState per event
  // re-rendered the whole pane at event cadence (see frame-batcher).
  const dragBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => dragBatcher.dispose(), [dragBatcher])
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragOrigin.current = { y: event.clientY, h: paneHeight }
    const onMove = (ev: PointerEvent): void => {
      if (dragOrigin.current === null) return
      const next = clamp(dragOrigin.current.h + (dragOrigin.current.y - ev.clientY))
      dragBatcher.schedule(() => { setDragHeight(next) })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragOrigin.current = null
      dragBatcher.flushNow()
      setDragHeight(current => {
        if (current !== null) onHeightCommit(current)
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const title = target.kind === 'op'
    ? target.path
    : target.ref.kind === 'worktree' ? target.ref.path : `${target.ref.hash} ${target.ref.subject}`
  const stats = gitStats ?? (target.kind === 'op' && op !== null && op.kind !== 'read' && !op.isError ? opStats : null)

  const handle = (
    <div
      className={css.dragHandle}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('changesResizePreview')}
      tabIndex={0}
      onPointerDown={onHandleDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); onHeightCommit(clamp(paneHeight + HEIGHT_STEP)) }
        if (event.key === 'ArrowDown') { event.preventDefault(); onHeightCommit(clamp(paneHeight - HEIGHT_STEP)) }
      }}
    />
  )
  const strip = hasStrip ? <PaneTabStrip tabs={allTabs} active={active} onSelect={onSelectTab ?? (() => {})} /> : null

  // A caller-hosted view (the graph commit's card) takes over the head AND
  // the body: same frame, same handle, same height behaviour — only the
  // content inside the frame changes. Nothing available → its empty state.
  if (activeExtra) {
    return (
      <div className={css.diffPane} data-diff-pane="" style={{ height: paneHeight }}>
        {handle}
        {strip}
        <div className={css.altBody}>{bodies?.[active] ?? <PaneEmpty text={t('changesNoContent')} />}</div>
      </div>
    )
  }

  /** Which rendering the content view uses. Resolved up front so this stays a
   *  single switch (an aliased-condition narrowing would turn `target` into
   *  `never` in the remaining branch). */
  const contentView: 'pdf' | 'html' | 'md' | 'source' =
    pdfOp && contentAbs !== '' ? 'pdf'
      : htmlOp && !contentRaw && htmlRenderSrc !== '' ? 'html'
        : mdOp && !contentRaw && contentText !== '' ? 'md'
          : 'source'
  /** The `content` tab's body: the plugin's rendered view for md/html/pdf
   *  (with the source toggle for md/html), line-numbered source otherwise, and
   *  the worktree file itself for a git target — the diff tab keeps the patch. */
  const contentBody = (
    contentView === 'pdf'
      ? (
        <div className={css.htmlPane}>
          <PdfView scope={scope} path={contentAbs} title={title} />
        </div>
      )
      : contentView === 'html'
        ? <HtmlRenderPreview src={htmlRenderSrc} title={title} />
        : contentView === 'md'
          ? <MdReadingView text={contentText} ctx={ctx} scope={scope} path={contentPath} />
          : gitWorktree !== null
            ? (gitContent.status === 'loading' || gitContent.status === 'idle'
              ? <div className={css.paneBody}><Notice kind="loading" tone="page">{t('loading')}</Notice></div>
              : gitContent.status === 'error'
                ? <div className={css.paneBody}><Notice kind="error">{t('diffLoadError')}: {gitContent.error}</Notice></div>
                : gitContent.status === 'binary' || gitContent.status === 'large'
                  ? <div className={css.paneBody}><BinaryDownload scope={scope} path={contentAbs} /></div>
                  : (
                    <div className={css.paneBody}>
                      <ReadRows lines={contentLines} lang={langOfPath(gitWorktree.path)} />
                    </div>
                  ))
            : (
              <div className={css.paneBody}>
                <ReadRows lines={opKind === 'read' ? opReadLines : contentLines} lang={opLang} />
              </div>
            )
  )

  return (
    <div className={css.diffPane} data-diff-pane="" style={{ height: fill ? '100%' : paneHeight }}>
      {!fill && handle}
      {strip}
      <div className={css.diffHead}>
        {target.kind === 'op' && (
          <StatusBadge tone={target.op.kind}>
            {t(target.op.kind === 'read' ? 'changesRead' : target.op.kind === 'write' ? 'changesWrite' : 'changesEdit')}
          </StatusBadge>
        )}
        {target.kind === 'git' && target.ref.kind === 'worktree' && (
          <StatusBadge tone="neutral">{target.ref.staged ? t('staged') : t('unstaged')}</StatusBadge>
        )}
        {target.kind === 'git' && target.ref.kind === 'commit' && (
          <StatusBadge tone="neutral">{target.ref.hash}</StatusBadge>
        )}
        <span className={css.diffPath} title={title}>{title}</span>
        {active === 'diff' && stats !== null && (stats.added > 0 || stats.deleted > 0) && (
          <span className={css.diffStats}>
            {stats.added > 0 && <span className={diffCss.statAdd}>+{String(stats.added)}</span>}
            {stats.deleted > 0 && <span className={diffCss.statDel}>−{String(stats.deleted)}</span>}
          </span>
        )}
        {target.kind === 'git' && (
          <>
            <IconButton
              size="sm"
              icon={<IconRefreshOutlineRegular size={14} />}
              label={t('refresh')}
              disabled={loading}
              onClick={refresh}
            />
            <IconButton
              size="sm"
              icon={<IconRightUpOutlineRegular size={14} />}
              label={t('changesOpenDiffTab')}
              onClick={onExpand}
            />
          </>
        )}
        {redactionHit && (
          <span className={css.redactBanner} role="status">{t('changesRedactBanner')}</span>
        )}
        {target.kind === 'op' && (
          <PaneToggle
            on={redactionOn}
            label={redactionOn ? t('changesRedactOnLabel') : t('changesRedactOffLabel')}
            title={redactionOn ? t('changesRedactOff') : t('changesRedactOn')}
            onClick={toggleRedaction}
          />
        )}
        {/* The rendered/source toggle belongs to the CONTENT tab alone. */}
        {active === 'content' && mdOp && (
          <PaneToggle
            on={!contentRaw}
            label={t(contentRaw ? 'changesMdReading' : 'changesMdRaw')}
            onClick={() => { setContentRaw(value => !value) }}
          />
        )}
        {active === 'content' && htmlOp && (
          <PaneToggle
            on={!contentRaw}
            label={t(contentRaw ? 'changesHtmlRender' : 'changesHtmlRaw')}
            onClick={() => { setContentRaw(value => !value) }}
          />
        )}
        {!fill && <IconButton
          size="sm"
          icon={<IconCloseOutlineRegular size={14} />}
          label={t('changesClosePreview')}
          onClick={onClose}
        />}
      </div>
      {active === 'content'
        ? (hasContentTab ? contentBody : <PaneEmpty text={t('changesNoContent')} />)
        : active === 'diff'
        ? (opError
          ? (
            <div className={css.paneBody}>
              <Notice kind="error" className={css.readError}>
                {op?.errorText ?? t('changesError')}
              </Notice>
            </div>
          )
          : opKind === 'read'
            // A read changed nothing: the diff view says so plainly instead of
            // rendering an empty patch.
            ? <PaneEmpty text={t('changesReadNoDiff')} />
            : target.kind === 'op'
              ? (
                <div className={css.paneBody} ref={opBodyRef}>
                  {op !== null && op.kind === 'write'
                    && prior === undefined
                    && <Notice kind="hint" tone="inline">{t('changesPriorUnknown')}</Notice>}
                  {opReview?.result != null && (
                    <div className={css.reviewBar} data-changes-op-review="">
                      <span className={css.reviewProgress}>
                        {opReview.result.kind === 'keep' ? t('reviewKept') : t('reviewRejected')}
                      </span>
                      <button
                        type="button"
                        className={css.reviewNav}
                        disabled={opReview.busy || opReview.undo.length === 0}
                        onClick={() => { void undoOpReview() }}
                      >
                        {t('reviewUndo')} <kbd className={css.reviewKbd}>Ctrl+Z</kbd>
                      </button>
                      <span className={css.reviewHint}>{t('changesReviewWriteHint')}</span>
                    </div>
                  )}
                  {opReview === null && reviewNotice !== null && (
                    <Notice kind="hint" tone="inline">{reviewNotice}</Notice>
                  )}
                  {opReview?.error != null && (
                    <Notice kind="error">{t('saveFailed')}: {opReview.error}</Notice>
                  )}
                  <DiffRows
                    key={target.op.callId}
                    segments={opSegments}
                    lang={opLang}
                    review={opReviewOverlay}
                  />
                </div>
              )
              : loading
                ? <div className={css.paneBody}><Notice kind="loading" tone="page">{t('loading')}</Notice></div>
                : error !== null
                  ? (
                    <div className={css.paneBody}>
                      <Notice kind="error">{t('diffLoadError')}: {error}</Notice>
                    </div>
                  )
                  : (
                    <div className={css.paneBody}>
                      {/* The untracked fallback has NO diff text (git diff never
                          lists the file): its content is the whole render. */}
                      {((diffText !== null && diffText !== '') || untracked !== undefined) && (
                        target.ref.kind === 'worktree' && effectiveStaged === false
                        ? <WorktreeReview key={diffText} ctx={ctx} scope={scope} diff={target.ref} fallback={<DiffFiles diff={diffText ?? ''} resolveFold={resolveFold}
                            untrackedPath={untracked !== undefined ? target.ref.path : undefined} untrackedContent={untracked} />} />
                        : <DiffFiles
                          diff={diffText ?? ''}
                          resolveFold={resolveFold}
                          untrackedPath={untracked !== undefined && target.ref.kind === 'worktree' ? target.ref.path : undefined}
                          untrackedContent={untracked}
                        />
                      )}
                      {diffText === '' && untracked === undefined && (
                        <Notice kind="empty" tone="page">{t('diffEmpty')}</Notice>
                      )}
                    </div>
                  ))
        : (bodies?.[active] ?? <PaneEmpty text={t('changesNoContent')} />)}
    </div>
  )
}
