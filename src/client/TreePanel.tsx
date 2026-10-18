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
import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { IconChevronsUpDownOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { ancestorDirs } from './state.ts'
import { FileTree } from './FileTree.tsx'
import { FileGrid } from './FileGrid.tsx'
import { FileColumns } from './FileColumns.tsx'
import { DEFAULT_FILE_TREE_SORT, type FileTreeSort } from './file-tree-sort.ts'
import { IconColumnsOutline16, IconGridOutline16, IconListOutline16, IconUploadOutline16 } from './icons.tsx'
import type { OpenInApp } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { isWithinWorkspace, resolveSidebarPath } from './paths.ts'
import { IGNORE_FILE, parseIgnoreFile } from './ignore-file.ts'
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
const FILES_VIEW_MIGRATION_KEY = 'dsh-cursorlike-sidebar:files-view-v3'
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
    // One-time migration to the new desktop-grid default. Columns remains a
    // deliberate choice; a tree chosen later (after the marker exists) is kept.
    if (localStorage.getItem(FILES_VIEW_MIGRATION_KEY) === null) {
      localStorage.setItem(FILES_VIEW_MIGRATION_KEY, '1')
      return value === 'columns' ? 'columns' : 'grid'
    }
    return value === 'tree' || value === 'columns' ? value : 'grid'
  } catch {
    return 'grid'
  }
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
  const [sort, setSort] = useState<FileTreeSort>(DEFAULT_FILE_TREE_SORT)
  const [sortOpen, setSortOpen] = useState(false)
  /** Desktop-icon grid vs the original tree; persisted for the next open. */
  const [view, setView] = useState<FilesView>(readFilesView)
  /** Grid icon size driven by Ctrl+wheel over the Files panel. */
  const [iconSize, setIconSize] = useState(readFilesIconSize)

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
    if (items.length === 0 || cwd === undefined || upload !== null) return
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

  const busy = upload !== null
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

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
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
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
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
            sessionId={sessionId}
            cwd={cwd}
            exclude={effectiveExclude}
            visible={visible !== false}
            service={service}
            iconSize={iconSize}
            onIconSizeChange={changeIconSize}
            onOpenFile={onOpenFile}
            onOpenFileNewTab={onOpenFileNewTab}
            onOpenFileSide={onOpenFileSide}
            onReferenceFile={onReferenceFile}
          />
        ) : (
          <FileColumns
            sessionId={sessionId}
            cwd={cwd}
            exclude={effectiveExclude}
            visible={visible !== false}
            service={service}
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
