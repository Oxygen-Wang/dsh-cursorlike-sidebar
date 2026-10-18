/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over the shared controlled FileTree. The results panel and the tree are
 * BOTH mounted: the query only parks one of them (`hidden`), so clearing the
 * search is free — the tree keeps its level cache and the live directory
 * watcher (the old conditional render dropped both and refetched the whole
 * visible set on every query change). Owns its refresh tick: the icon next to
 * the search input clears the tree cache, and the sort menu beside it owns the
 * tree's row order (passed down; the default is the host's own order).
 * EditorHost docks it as the tab's right panel (wrapped in a drag-resize
 * handle) and provides the file context-menu open escapes.
 *
 * Uploads (header pickers, the tree's drag-drop and "upload here" menu)
 * all funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { IconChevronsUpDownOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { ancestorDirs } from './state.ts'
import { FileTree } from './FileTree.tsx'
import { FileGrid } from './FileGrid.tsx'
import { FileColumns } from './FileColumns.tsx'
import { DEFAULT_FILE_TREE_SORT, type FileTreeSort } from './file-tree-sort.ts'
import { IconColumnsOutline16, IconEyeOffOutline16, IconGridOutline16, IconListOutline16, IconUploadOutline16 } from './icons.tsx'
import type { OpenInApp } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { isWithinWorkspace, relativeTo, resolveSidebarPath } from './paths.ts'
import { readCursorlikeDrag } from './cursorlike-interactions.ts'
import { useFileHistory } from './use-file-history.tsx'
import { hasUnsavedPath } from './editor-dirty.ts'
import { consumeFileClipboard, readFileClipboard, topLevelPaths, writeFileClipboard, type FileTransferMode } from './file-clipboard.ts'
import { IGNORE_FILE, appendIgnorePatterns, parseIgnoreFile } from './ignore-file.ts'
import { ensureIgnoreFile } from './ensure-ignore-file.ts'
import { IconButton } from './ui/index.ts'
import { UploadOverlay } from './UploadOverlay.tsx'
import {
  summarizeResults, uploadHintText, uploadItemsFromFiles, uploadToDir,
  UPLOAD_HINT_MS, type UploadItem,
} from './upload.ts'
import css from './sidebar.module.css'

/** Files view preference (tree, desktop icon grid, or Miller columns). */
type FilesView = 'tree' | 'grid' | 'columns'
const FILES_VIEW_KEY = 'dsh-cursorlike-sidebar:files-view'
const FILES_SORT_KEY = 'dsh-cursorlike-sidebar:files-sort'
const FILES_ICON_KEY = 'dsh-cursorlike-sidebar:files-icon-size'
const FILES_ICON_DEFAULT = 48
const FILES_ICON_MIN = 24
const FILES_ICON_MAX = 160

/**
 * Read the persisted Files view. The desktop grid is the default; a stored
 * choice (tree or columns) still wins.
 * @returns the view to mount.
 */
function readFilesView(): FilesView {
  try {
    const value = localStorage.getItem(FILES_VIEW_KEY)
    return value === 'tree' || value === 'columns' ? value : 'grid'
  } catch {
    return 'grid'
  }
}

function readFilesSort(): FileTreeSort {
  try {
    const value = JSON.parse(localStorage.getItem(FILES_SORT_KEY) ?? 'null') as FileTreeSort | null
    if (value !== null && (value.key === 'name' || value.key === 'type') && typeof value.dirsFirst === 'boolean') return value
  } catch { /* malformed or unavailable storage */ }
  return DEFAULT_FILE_TREE_SORT
}

/** Read the persisted grid icon size, clamped for the wheel zoom range. */
function readFilesIconSize(): number {
  try {
    const raw = localStorage.getItem(FILES_ICON_KEY)
    const value = raw === null ? FILES_ICON_DEFAULT : Number(raw)
    return Number.isFinite(value) ? Math.min(FILES_ICON_MAX, Math.max(FILES_ICON_MIN, value)) : FILES_ICON_DEFAULT
  } catch {
    return FILES_ICON_DEFAULT
  }
}

/** One in-flight upload session (the overlay's progress source). */
interface UploadSession {
  dir: string
  done: number
  total: number
  /** Relative path of the file being uploaded ('' when none is in flight). */
  current: string
  controller: AbortController
}

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  /** The host's open-in-app handle (passed through to FileTree; absent →
   *  the HOST half of the "打开方式" section is hidden). */
  openInApp?: OpenInApp
  /** The plugin's own open-with targets (passed through to FileTree; coexists
   *  with `openInApp`; absent → no plugin half). */
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  /** Open one plugin target (passed through to FileTree; `false`/rejection →
   *  the tree reports the failure in its strip). */
  onOpenWith?: (targetId: string, path: string) => void | boolean | Promise<void | boolean>
  onToggleOpenWithPin?: (targetId: string) => void
  /** Show the plugin's own open-with targets even when the host lists local
   *  applications for the path (the `openWithPluginTargets` setting; passed
   *  through to FileTree). */
  openWithShowPluginTargets?: boolean
  onReferenceFile: (path: string, isDir: boolean) => void
  /** The explorerExclude pref patterns: the host filters the tree listing AND
   *  the name search with them (passed through to FileTree, and carried on the
   *  search request so both surfaces agree). */
  exclude?: readonly string[]
  /** A tree rename landed (passed through to FileTree for tab retargeting). */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A tree delete landed (passed through to FileTree for tab closing). */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Whether the owning tab is on screen: a parked tab stops the tree's git
   *  polling (the shared status store pauses when nothing visible wants it). */
  visible?: boolean
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** The sidebar registry service (file-icon registrations; passed through to FileTree). */
  service?: BetterSidebarService
}) {
  const {
    sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets, exclude,
    onReferenceFile, onPathRenamed, onPathDeleted, visible, full, service,
  } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; dirs: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The explorer's row order (the header's sort control). Starts at the
   * default — name order, folders first — which is the order the host already
   * returns, so the tree looks exactly as it did before the control existed.
   */
  const [sort, setSort] = useState<FileTreeSort>(readFilesSort)
  useEffect(() => {
    try { localStorage.setItem(FILES_SORT_KEY, JSON.stringify(sort)) } catch { /* keep the in-memory choice */ }
  }, [sort])
  const [sortOpen, setSortOpen] = useState(false)
  /** Desktop-icon grid vs the original tree; persisted for the next open. */
  const [view, setView] = useState<FilesView>(readFilesView)
  /** Grid icon size driven by Ctrl+wheel over the Files panel. */
  const [iconSize, setIconSize] = useState(readFilesIconSize)
  /** The `.ignore` drop target's hover state. */
  const [ignoreDropActive, setIgnoreDropActive] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [transferring, setTransferring] = useState(false)
  const transferLock = useRef(false)
  const transferGeneration = useRef(0)
  const scopeKey = JSON.stringify([sessionId, cwd])
  const liveScope = useRef(scopeKey)
  liveScope.current = scopeKey
  useEffect(() => {
    transferGeneration.current += 1
    setTransferError(null); setTransferring(false); transferLock.current = false
    return () => { transferGeneration.current += 1 }
  }, [scopeKey])
  const transferFiles = (dir: string, paths: string[], mode: FileTransferMode): void => {
    if (cwd === undefined || transferLock.current || busy) return
    transferLock.current = true
    setTransferring(true)
    setTransferError(null)
    const key = scopeKey
    const generation = transferGeneration.current
    const active = (): boolean => liveScope.current === key && transferGeneration.current === generation
    const scope = { sessionId, cwd }
    const sources = topLevelPaths(paths)
    const group = sources.length > 1 ? crypto.randomUUID() : undefined
    void (async () => {
      for (const path of sources) {
        if (!active()) return
        const result = await (group === undefined ? api.fsTransfer(scope, path, dir, mode) : api.fsTransfer(scope, path, dir, mode, group))
        if (!active()) return
        if (mode === 'move') {
          consumeFileClipboard(scope, path)
          onPathRenamed?.(path, result.path)
        }
      }
    })().catch((failure: unknown) => {
      if (active()) setTransferError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (!active()) return
      transferLock.current = false
      setTransferring(false)
      setRefreshTick(tick => tick + 1)
    })
  }
  /** The directory under a pointer, with the view's current directory as fallback. */
  const dropDir = (target: HTMLElement): string | undefined => {
    const explicit = target.closest<HTMLElement>('[data-cursorlike-drop-dir]')
    const row = target.closest<HTMLElement>('[data-cursorlike-path]')
    if (explicit !== null && (row === null || row.contains(explicit))) return explicit.dataset.cursorlikeDropDir
    if (row?.dataset.cursorlikeDirectory === 'true') return row.dataset.cursorlikePath
    const path = row?.dataset.cursorlikePath
    if (path !== undefined) return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || cwd
    return target.closest<HTMLElement>('[data-cursorlike-drop-dir]')?.dataset.cursorlikeDropDir ?? cwd
  }
  const internalDrag = (event: DragEvent<HTMLElement>): boolean => event.dataTransfer.types.includes('application/x-cursorlike-context')

  // The tree caches loaded directories per refresh tick, so content changed
  // outside DSH (another editor, a sync tool) stays stale until the manual
  // refresh click. Re-focusing the window bumps the tick automatically, and
  // integrations can force a refresh by dispatching a bubbling
  // `dsh-sidebar:refresh-files` event on `window`.
  useEffect(() => {
    const bump = (): void => { setRefreshTick(tick => tick + 1) }
    window.addEventListener('focus', bump)
    window.addEventListener('dsh-sidebar:refresh-files', bump)
    return () => {
      window.removeEventListener('focus', bump)
      window.removeEventListener('dsh-sidebar:refresh-files', bump)
    }
  }, [])
  /**
   * Per-workspace `.ignore` rules (root file). Read through the ordinary
   * `fs.read` route — no host change needed — and re-read on the same refresh
   * tick as the tree, so editing `.ignore` and clicking refresh is enough.
   * Missing/unreadable files degrade to "no rules" instead of an error: a
   * `.ignore` file is optional.
   */
  const [ignorePatterns, setIgnorePatterns] = useState<string[]>([])
  useEffect(() => {
    if (cwd === undefined) {
      setIgnorePatterns([])
      return
    }
    const controller = new AbortController()
    // Older test mocks (and stripped hosts) may not expose the read route:
    // `.ignore` is optional, so degrade to "no rules" instead of throwing
    // inside an effect.
    if (typeof api.fsRead !== 'function') {
      setIgnorePatterns([])
      return () => controller.abort()
    }
    const request = api.fsRead({ sessionId, cwd }, resolveSidebarPath(cwd, IGNORE_FILE), controller.signal)
    if (request === undefined || typeof request.then !== 'function') {
      setIgnorePatterns([])
      return () => controller.abort()
    }
    request.then((result) => {
      if (controller.signal.aborted) return
      setIgnorePatterns(result.kind === 'text' ? parseIgnoreFile(result.content) : [])
    }).catch(() => {
      if (!controller.signal.aborted) setIgnorePatterns([])
    })
    return () => controller.abort()
  }, [sessionId, cwd, refreshTick])
  /** One-line upload status under the search row ('' hides the hint). */
  const [uploadStatus, setUploadStatus] = useState('')
  /** Whether the status line is a failure/cancel (error color, stays visible). */
  const [uploadFailed, setUploadFailed] = useState(false)
  /** The in-flight upload session (null → no overlay, buttons enabled). */
  const [upload, setUpload] = useState<UploadSession | null>(null)
  /** True between the cancel click and the session settling (button disabled). */
  const [cancelling, setCancelling] = useState(false)
  /** Set by cancelUpload; the settle path shows 'upload cancelled' instead of
   *  summarizing the partial results. */
  const cancelledRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  /** Start one upload session into `dir` (absolute, inside the workspace). */
  const startUpload = (dir: string, items: UploadItem[]): void => {
    if (items.length === 0 || cwd === undefined || busy) return
    cancelledRef.current = false
    const controller = new AbortController()
    setUploadFailed(false)
    setUploadStatus(uploadHintText(0, items.length, '', dir, t))
    setUpload({ dir, done: 0, total: items.length, current: '', controller })
    void uploadToDir({ sessionId, cwd }, dir, items, (done, total, current) => {
      if (current !== '') setUploadStatus(uploadHintText(done, total, current, dir, t))
      setUpload(session => session === null ? session : { ...session, done, total, current })
    }, controller.signal).then((results) => {
      setUpload(null)
      setCancelling(false)
      // Reload the tree whatever the outcome: files may have landed before a
      // cancel, and failures leave whatever did succeed visible.
      setRefreshTick(tick => tick + 1)
      if (cancelledRef.current) {
        setUploadStatus(t('uploadCancelled'))
        setUploadFailed(true)
        return
      }
      const status = summarizeResults(results, t)
      setUploadStatus(status)
      setUploadFailed(results.some(result => !result.ok))
      // Success messages are transient; failures stay until the next action.
      if (results.every(result => result.ok)) {
        window.setTimeout(() => {
          setUploadStatus(current => current === status ? '' : current)
        }, UPLOAD_HINT_MS)
      }
    })
  }

  /** Cancel the in-flight upload (aborts the request; the host drops its temp). */
  const cancelUpload = (): void => {
    if (upload === null || cancelling) return
    cancelledRef.current = true
    setCancelling(true)
    upload.controller.abort()
  }

  const folderInputProps = { webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>

  const needle = query.trim()
  const searching = needle !== ''
  /**
   * The client pref list plus the workspace `.ignore` file. Deduplicated so a
   * pattern repeated in both sources does not change the host cache key.
   */
  const effectiveExclude = useMemo(
    () => Array.from(new Set([...(exclude ?? []), ...ignorePatterns])),
    [exclude, ignorePatterns],
  )
  // The search effect below must re-run on a CHANGED list, never on a churned
  // array identity: the prefs store hands out one stable reference per
  // document, but keying on the value is what makes that a guarantee rather
  // than an assumption (a re-run resets the 300ms debounce, so a per-render
  // identity would keep the search from ever settling).
  const excludeKey = effectiveExclude.join('\0')
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    const patterns = excludeKey === '' ? undefined : excludeKey.split('\0')
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, patterns, controller.signal).then((found) => {
        setResults(found)
        setError(null)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setResults(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, cwd, needle, excludeKey])

  const canRemovePaths = (paths: string[]): boolean => {
    if (paths.some(path => hasUnsavedPath(sessionId, path, cwd))) {
      setTransferError(t('fileHistoryUnsaved'))
      return false
    }
    setTransferError(null)
    return true
  }
  const history = useFileHistory({ sessionId, cwd }, effect => {
    if (effect.type === 'move') onPathRenamed?.(effect.from, effect.path)
    else if (effect.type === 'remove') onPathDeleted?.(effect.path, effect.isDir)
  }, upload !== null || transferring, (step, direction) => {
    const removes = direction === 'undo' ? ['copy', 'file', 'folder'].includes(step.kind) : step.kind === 'delete'
    return !removes || !step.paths.some(path => hasUnsavedPath(sessionId, path, cwd))
  })
  const busy = upload !== null || transferring || history.busy
  /** Directory hits (the host reports them separately): a click navigates the
   *  tree for those rows instead of opening them as files. */
  const dirHits = useMemo(() => new Set(results?.dirs), [results])

  /**
   * Jump to a DIRECTORY hit in the tree. Results include directories (they
   * show where matches live) and `fs.read` refuses one, so opening such a row
   * as a file surfaced a bare `"…" is a directory` error. Expand the folder
   * and its ancestors instead — `onToggle` FLIPS a row, so only collapsed
   * paths are touched — and clear the query so the tree, not the parked
   * results panel, is what the user sees next.
   */
  // A directory hit OUTSIDE the cwd (a pasted absolute path from the
  // direct-open branch) has no tree rows to expand: the tree is cwd-rooted,
  // and `ancestorDirs` would synthesize cwd-length prefixes of a foreign
  // path that toggle nothing and persist as junk `expanded` entries. Such a
  // row only clears the query.
  const openSearchDir = (rel: string): void => {
    const target = resolveSidebarPath(cwd, rel)
    if (cwd !== undefined && isWithinWorkspace(cwd, target)) {
      for (const path of [...ancestorDirs(cwd, [target]), target]) {
        if (!expanded.includes(path)) onToggle(path)
      }
    }
    setQuery('')
  }

  /** Persist and apply one Files view change. */
  const changeView = (next: FilesView): void => {
    setView(next)
    try {
      localStorage.setItem(FILES_VIEW_KEY, next)
    } catch {
      /* storage unavailable: keep the in-memory view */
    }
  }

  /** Clamp, persist and apply one Ctrl+wheel grid size. */
  const changeIconSize = (next: number): void => {
    const clamped = Math.min(FILES_ICON_MAX, Math.max(FILES_ICON_MIN, Math.round(next)))
    setIconSize(clamped)
    try {
      localStorage.setItem(FILES_ICON_KEY, String(clamped))
    } catch {
      /* storage unavailable: keep the in-memory size */
    }
  }

  /** Append dragged workspace paths to the root `.ignore`, then refresh. */
  const dropToIgnore = async (transfer: DataTransfer): Promise<void> => {
    if (cwd === undefined) return
    const value = readCursorlikeDrag(transfer)
    if (value === undefined || value.sessionId !== sessionId) return
    const ignorePath = resolveSidebarPath(cwd, IGNORE_FILE)
    const patterns = value.paths.map((item) => {
      const rel = relativeTo(cwd, item.path).replace(/\\/g, '/')
      return item.directory ? `${rel.replace(/\/+$/, '')}/` : rel
    }).filter(pattern => pattern !== '' && pattern !== '.' && !pattern.startsWith('..') && pattern !== IGNORE_FILE)
    if (patterns.length === 0) return
    let content = ''
    let mtime: number | undefined
    try {
      if (typeof api.fsRead !== 'function') return
      const current = await api.fsRead({ sessionId, cwd }, ignorePath)
      if (current.kind === 'text') {
        content = current.content
        mtime = current.mtimeMs
      }
    } catch {
      try {
        const current = await ensureIgnoreFile({ sessionId, cwd })
        content = current.content
        mtime = current.mtimeMs
      } catch (error) {
        setTransferError(error instanceof Error ? error.message : String(error))
        return
      }
    }
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '')
    const additions = patterns.filter(pattern => !lines.includes(pattern))
    if (additions.length === 0) return
    const next = appendIgnorePatterns(content, additions)
    try {
      await api.fsWrite({ sessionId, cwd }, ignorePath, next, mtime)
      setRefreshTick(tick => tick + 1)
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}
      onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.altKey || (event.target as HTMLElement).closest('input,textarea,[contenteditable="true"],[role="dialog"],.cm-editor')) return
        const element = event.target as HTMLElement
        if (event.ctrlKey || event.metaKey) {
          const key = event.key.toLowerCase()
          if (key === 'z' || (!event.shiftKey && key === 'y')) {
            event.preventDefault(); event.stopPropagation()
            if (!busy) { if (event.shiftKey || key === 'y') history.redo(); else history.undo() }
            return
          }
        }
        if (event.shiftKey) return
        if (event.key === 'F5') {
          event.preventDefault(); event.stopPropagation(); setRefreshTick(tick => tick + 1); return
        }
        if (!(event.ctrlKey || event.metaKey)) return
        const key = event.key.toLowerCase()
        if (!['c', 'x', 'v'].includes(key) || busy) return
        if (key === 'v') {
          const value = readFileClipboard({ sessionId, cwd })
          const dir = dropDir(element)
          if (value === undefined || value.paths.length === 0 || dir === undefined) return
          event.preventDefault(); event.stopPropagation()
          transferFiles(dir, value.paths, value.mode)
        } else {
          const pane = element.closest('[data-cursorlike-drop], [data-cursorlike-file-grid]')
          const selected = [...(pane?.querySelectorAll<HTMLElement>('[data-dsh-selected="true"][data-cursorlike-path]') ?? [])].map(row => row.dataset.cursorlikePath!)
          const path = element.closest<HTMLElement>('[data-cursorlike-path]')?.dataset.cursorlikePath
          const paths = selected.length > 0 ? selected : path === undefined ? [] : [path]
          if (paths.length === 0) return
          event.preventDefault(); event.stopPropagation()
          writeFileClipboard({ sessionId, cwd }, paths, key === 'x' ? 'move' : 'copy')
        }
      }}
      onDragOverCapture={event => {
        if (!internalDrag(event) || (event.target as HTMLElement).closest('[data-cursorlike-ignore-drop]')) return
        event.preventDefault(); event.stopPropagation()
        event.dataTransfer.dropEffect = busy ? 'none' : event.ctrlKey || event.metaKey ? 'copy' : 'move'
      }}
      onDropCapture={event => {
        if (!internalDrag(event) || (event.target as HTMLElement).closest('[data-cursorlike-ignore-drop]')) return
        event.preventDefault(); event.stopPropagation()
        const value = readCursorlikeDrag(event.dataTransfer)
        const dir = dropDir(event.target as HTMLElement)
        if (value === undefined || value.sessionId !== sessionId || value.cwd !== cwd || value.lineStart !== undefined || dir === undefined) return
        transferFiles(dir, value.paths.map(item => item.path), event.ctrlKey || event.metaKey ? 'copy' : 'move')
      }}>
      <div className={css.editorTreeSearch}>
        <input
          className={css.editorSearchInput}
          value={query}
          placeholder={t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <IconButton
          label={t('refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => { setRefreshTick(tick => tick + 1) }}
        />
        <IconButton
          label={t('files')}
          icon={view === 'tree'
            ? <IconGridOutline16 size={14} />
            : view === 'grid'
              ? <IconColumnsOutline16 size={14} />
              : <IconListOutline16 size={14} />}
          onClick={() => {
            changeView(view === 'tree' ? 'grid' : view === 'grid' ? 'columns' : 'tree')
          }}
        />
        <div
          data-cursorlike-ignore-drop=""
          className={clsx(css.ignoreDrop, ignoreDropActive && css.ignoreDropActive)}
          onDragEnter={(event) => {
            if (event.dataTransfer?.types.includes('application/x-cursorlike-context') === true) {
              event.preventDefault()
              setIgnoreDropActive(true)
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer?.types.includes('application/x-cursorlike-context') !== true) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setIgnoreDropActive(true)
          }}
          onDragLeave={() => { setIgnoreDropActive(false) }}
          onDrop={(event) => {
            event.preventDefault()
            setIgnoreDropActive(false)
            void dropToIgnore(event.dataTransfer)
          }}
        >
          <IconButton
            label=".ignore"
            title=".ignore"
            icon={<IconEyeOffOutline16 size={14} />}
            onClick={() => {
              if (cwd === undefined || busy) return
              const armed = liveScope.current
              void ensureIgnoreFile({ sessionId, cwd }).then(() => {
                if (liveScope.current !== armed) return
                setTransferError(null)
                setRefreshTick(tick => tick + 1)
                onOpenFile(resolveSidebarPath(cwd, IGNORE_FILE))
              }).catch((error: unknown) => {
                if (liveScope.current === armed) setTransferError(error instanceof Error ? error.message : String(error))
              })
            }}
          />
        </div>
        {/* Row order: the two keys are one choice (check mark), the
            folders-first switch is independent — the same two-group menu the
            host's own menus use. Picking a row closes the menu like every
            other menu in the plugin. */}
        <Menu
          open={sortOpen}
          onClose={() => { setSortOpen(false) }}
          onSelect={(id) => {
            setSort((current) => {
              if (id === 'sort-name') return { ...current, key: 'name' }
              if (id === 'sort-type') return { ...current, key: 'type' }
              return { ...current, dirsFirst: !current.dirsFirst }
            })
            setSortOpen(false)
          }}
          items={[
            { id: 'sort-name', label: t('sortByName'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
            { id: 'sort-type', label: t('sortByType'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
            { type: 'separator', id: 'sort-sep' },
            { id: 'sort-folders-first', label: t('sortFoldersFirst') },
          ]}
          selectedIds={[
            sort.key === 'name' ? 'sort-name' : 'sort-type',
            ...(sort.dirsFirst ? ['sort-folders-first'] : []),
          ]}
          align="end"
          compact
          anchor={(
            <IconButton
              label={t('sort')}
              icon={<IconChevronsUpDownOutlineRegular size={14} />}
              onClick={() => { setSortOpen(open => !open) }}
            />
          )}
        />
        <IconButton
          label={t('uploadFiles')}
          icon={<IconUploadOutline16 size={14} />}
          disabled={busy}
          onClick={() => { fileInputRef.current?.click() }}
        />
        <IconButton
          label={t('uploadFolder')}
          icon={<IconFolderOpenRegular size={14} />}
          disabled={busy}
          onClick={() => { folderInputRef.current?.click() }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...folderInputProps}
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      <div className={css.fileHistoryToolbar} role="toolbar" aria-label={t('fileHistory')}>{history.toolbar}</div>
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
      {transferError !== null && <div className={clsx(css.editorSearchHint, css.editorError)} role="alert">{transferError}</div>}
      {transferring && <div className={css.editorSearchHint} role="status">{t('loading')}</div>}
      {history.feedback}
      {/* Search results: parked (not unmounted) while the query is empty. Its
          contents render only for a live query — a parked panel must not put
          state text (the loading line) into the panel's DOM. */}
      <div
        className={clsx(css.explorerBody, !searching && css.explorerHiddenPane)}
        hidden={!searching}
      >
        {searching && (
          <>
            {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
            {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
            {error === null && results !== null && results.matches.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
            )}
            {error === null && results !== null && results.matches.map((rel) => {
              const isDirHit = dirHits.has(rel)
              return (
                <button
                  key={rel}
                  type="button"
                  className={clsx(css.editorSearchResult, isDirHit && css.editorSearchResultDir)}
                  title={rel}
                  data-dsh-search-dir={isDirHit ? 'true' : undefined}
                  onClick={() => {
                    if (isDirHit) openSearchDir(rel)
                    else onOpenFile(resolveSidebarPath(cwd, rel))
                  }}
                >
                  {isDirHit && <IconFolderOpenRegular size={14} />}
                  <span className={css.editorSearchResultLabel}>{rel}</span>
                </button>
              )
            })}
            {error === null && results?.truncated === true && (
              <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
            )}
          </>
        )}
      </div>
      {/* The tree stays MOUNTED while searching: its level cache and the
          directory watcher survive a query, so clearing the box is free. */}
      {view !== 'tree' && !searching ? (
        view === 'grid' ? (
          <FileGrid
            key={scopeKey}
            sessionId={sessionId}
            cwd={cwd}
            exclude={effectiveExclude}
            visible={visible !== false}
            service={service}
            refreshTick={refreshTick}
            sort={sort}
            onPathRenamed={onPathRenamed}
            onPathDeleted={onPathDeleted}
            onUploadRequest={startUpload}
            busy={busy}
            onBeforeRemove={canRemovePaths}
            onTransferRequest={transferFiles}
            iconSize={iconSize}
            onIconSizeChange={changeIconSize}
            onOpenFile={onOpenFile}
            onOpenFileNewTab={onOpenFileNewTab}
            onOpenFileSide={onOpenFileSide}
            onReferenceFile={onReferenceFile}
          />
        ) : (
          <FileColumns
            key={scopeKey}
            sessionId={sessionId}
            cwd={cwd}
            exclude={effectiveExclude}
            visible={visible !== false}
            service={service}
            refreshTick={refreshTick}
            sort={sort}
            onPathRenamed={onPathRenamed}
            onPathDeleted={onPathDeleted}
            onUploadRequest={startUpload}
            busy={busy}
            onBeforeRemove={canRemovePaths}
            onTransferRequest={transferFiles}
            onOpenFile={onOpenFile}
            onOpenFileNewTab={onOpenFileNewTab}
            onOpenFileSide={onOpenFileSide}
            onReferenceFile={onReferenceFile}
          />
        )
      ) : (
      <FileTree
        sessionId={sessionId}
        cwd={cwd}
        expanded={expanded}
        revealed={revealed}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onOpenFileNewTab={onOpenFileNewTab}
        onOpenFileSide={onOpenFileSide}
        openInApp={openInApp}
        openWithTargets={openWithTargets}
        openWithPinned={openWithPinned}
        openWithSsh={openWithSsh}
        onOpenWith={onOpenWith}
        onToggleOpenWithPin={onToggleOpenWithPin}
        openWithShowPluginTargets={openWithShowPluginTargets}
        exclude={effectiveExclude}
        onReferenceFile={onReferenceFile}
        onPathRenamed={onPathRenamed}
        onPathDeleted={onPathDeleted}
        refreshTick={refreshTick}
        onUploadRequest={startUpload}
        busy={busy}
        onBeforeRemove={canRemovePaths}
        onTransferRequest={transferFiles}
        hidden={searching}
        visible={visible !== false}
        sort={sort}
        service={service}
      />
      )}
      {upload !== null && (
        <UploadOverlay
          dir={upload.dir}
          done={upload.done}
          total={upload.total}
          current={upload.current}
          onCancel={cancelUpload}
          cancelling={cancelling}
        />
      )}
    </div>
  )
}
