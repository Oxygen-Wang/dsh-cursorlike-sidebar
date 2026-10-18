/**
 * Desktop-style icon view for the Files window. It lists ONE directory at a
 * time (the explorer's tree remains the other view): the first tile is the
 * "back to parent" tile, folders open on click, files open on click, and the
 * existing drag reference / @-reference / open-in-tab actions are reused.
 *
 * The host already filters `exclude` and the root `.ignore`, so this component
 * never re-implements hidden-file policy: it asks `fs.tree` for the directory
 * and renders exactly the rows the tree would show.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, mediaUrl, type FsEntry, type SessionScope } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { writeReferenceDrag } from './cursorlike-interactions.ts'
import { baseName, isWithinWorkspace, relativeTo, resolveSidebarPath } from './paths.ts'
import { t } from './locales.ts'
import { IconArrowLeftOutline16 } from './icons.tsx'
import { IconButton } from './ui/index.ts'
import css from './sidebar.module.css'

/** The parent directory in the path's own spelling (separators preserved). */
function parentOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash <= 0) return path
  const parent = path.slice(0, slash)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/** Image extensions the large grid renders as real thumbnails. */
const IMAGE_PATH = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

interface GridMenuState {
  entry: FsEntry
  x: number
  y: number
}

export function FileGrid(props: {
  sessionId: string
  cwd: string | undefined
  exclude?: readonly string[]
  visible?: boolean
  service?: BetterSidebarService
  /** Icon/thumbnail size; Ctrl+wheel drives it. */
  iconSize: number
  onIconSizeChange: (next: number) => void
  onOpenFile: (path: string) => void
  onOpenFileNewTab?: (path: string) => void
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string, isDir: boolean) => void
}) {
  const {
    sessionId, cwd, exclude, visible, service,
    iconSize, onIconSizeChange,
    onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile,
  } = props
  const [currentDir, setCurrentDir] = useState<string | undefined>(cwd)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [menu, setMenu] = useState<GridMenuState | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const excludeKey = (exclude ?? []).join('\0')

  useEffect(() => {
    setCurrentDir(cwd)
  }, [cwd])

  useEffect(() => {
    if (cwd === undefined) return
    if (currentDir === undefined || !isWithinWorkspace(cwd, currentDir)) setCurrentDir(cwd)
  }, [cwd, currentDir])

  useEffect(() => {
    if (currentDir === undefined || cwd === undefined) return
    if (visible === false) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api.fsTree({ sessionId, cwd }, currentDir, excludeKey === '' ? undefined : excludeKey.split('\0'), controller.signal)
      .then((listing) => {
        if (controller.signal.aborted) return
        setEntries(listing.entries)
        setTruncated(listing.truncated)
        setLoading(false)
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setEntries([])
        setTruncated(false)
        setLoading(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => controller.abort()
  }, [sessionId, cwd, currentDir, excludeKey, refreshTick, visible])

  useEffect(() => {
    if (menu === null) return
    const close = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  // Ctrl/Cmd+wheel over the grid changes the icon/thumbnail size. The native
  // listener (not React's passive wheel) can preventDefault so the browser
  // does not zoom the whole GUI.
  useEffect(() => {
    const element = rootRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      onIconSizeChange(iconSize - Math.sign(event.deltaY) * 8)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [iconSize, onIconSizeChange])

  const scope = useMemo<SessionScope>(() => ({ sessionId, cwd }), [sessionId, cwd])
  const atRoot = cwd === undefined || currentDir === undefined || currentDir === cwd
  const relative = cwd !== undefined && currentDir !== undefined ? relativeTo(cwd, currentDir) : '.'
  const crumbs = useMemo(() => {
    if (cwd === undefined || currentDir === undefined) return []
    const rel = relativeTo(cwd, currentDir)
    if (rel === '.') return [{ label: baseName(cwd) || cwd, path: cwd }]
    const parts = rel.split('/')
    const out: { label: string; path: string }[] = []
    let at = cwd
    for (const part of parts) {
      at = resolveSidebarPath(at, part)
      out.push({ label: part, path: at })
    }
    return out
  }, [cwd, currentDir])

  const goBack = useCallback((): void => {
    if (cwd === undefined || currentDir === undefined || atRoot) return
    const parent = parentOf(currentDir)
    setCurrentDir(isWithinWorkspace(cwd, parent) ? parent : cwd)
  }, [atRoot, cwd, currentDir])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft'))) {
      event.preventDefault()
      goBack()
    }
  }

  const openEntry = (entry: FsEntry): void => {
    if (entry.isDir) setCurrentDir(entry.path)
    else onOpenFile(entry.path)
  }

  const iconFor = (entry: FsEntry): ReactNode => {
    if (entry.isDir) {
      return service !== undefined ? service.folderIcon(entry.path, true, iconSize) : builtinFolderIcon(true, iconSize)
    }
    return service !== undefined ? service.fileIcon(entry.path, iconSize) : builtinFileIcon(entry.path, iconSize)
  }

  const thumbFor = (entry: FsEntry): string | null => {
    if (entry.isDir || iconSize < 64 || !IMAGE_PATH.test(entry.path)) return null
    return mediaUrl(scope, entry.path)
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).catch(() => { /* clipboard unavailable */ })
    setMenu(null)
  }

  return (
    <div className={css.fileGridRoot} ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} data-cursorlike-file-grid="">
      <div className={css.fileGridHeader}>
        <IconButton
          label={t('parent')}
          icon={<IconArrowLeftOutline16 size={14} />}
          disabled={atRoot}
          onClick={goBack}
        />
        <div className={css.fileGridCrumbs}>
          {crumbs.map((crumb, index) => (
            <button
              key={crumb.path}
              type="button"
              className={css.fileGridCrumb}
              title={crumb.path}
              onClick={() => setCurrentDir(crumb.path)}
            >
              {index > 0 && <span className={css.fileGridCrumbSep}>/</span>}
              {crumb.label}
            </button>
          ))}
        </div>
        <IconButton
          label={t('refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => setRefreshTick(tick => tick + 1)}
        />
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && error === null && (
        <div className={css.fileGridScroll}>
          <div
            className={css.fileGrid}
            role="list"
            aria-label={relative}
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(88, iconSize + 44)}px, 1fr))` }}
          >
            <button
              type="button"
              className={clsx(css.fileGridItem, css.fileGridBack, atRoot && css.fileGridBackDisabled)}
              disabled={atRoot}
              title={t('parent')}
              onClick={goBack}
            >
              <span className={css.fileGridIcon} style={{ width: iconSize + 4, height: iconSize + 4 }}>
                <IconArrowLeftOutline16 size={Math.min(64, Math.max(24, iconSize))} />
              </span>
              <span className={css.fileGridLabel}>{t('parent')}</span>
            </button>
            {entries.map((entry) => {
              const thumb = thumbFor(entry)
              return (
              <button
                key={entry.path}
                type="button"
                role="listitem"
                draggable={!entry.broken}
                className={clsx(css.fileGridItem, entry.hidden && css.explorerHidden)}
                title={entry.path}
                data-cursorlike-path={entry.path}
                data-cursorlike-directory={entry.isDir ? 'true' : 'false'}
                onClick={() => openEntry(entry)}
                onDoubleClick={() => { if (!entry.isDir) onOpenFile(entry.path) }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ entry, x: event.clientX, y: event.clientY })
                }}
                onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                  writeReferenceDrag(event.dataTransfer, scope, [{ path: entry.path, directory: entry.isDir }])
                }}
              >
                <span className={css.fileGridIcon} style={{ width: iconSize + 4, height: iconSize + 4 }}>
                  {iconFor(entry)}
                  {thumb !== null && (
                    <img
                      className={css.fileGridThumb}
                      src={thumb}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      onError={(event) => { event.currentTarget.style.display = 'none' }}
                    />
                  )}
                </span>
                <span className={css.fileGridLabel}>{entry.name}</span>
              </button>
              )
            })}
          </div>
          {truncated && <div className={css.fileGridTruncated}>{t('filesTruncated')}</div>}
        </div>
      )}

      {menu !== null && createPortal(
        <div
          ref={menuRef}
          className={css.fileGridMenu}
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { openEntry(menu.entry); setMenu(null) }}>
            {t('openEditor')}
          </button>
          {!menu.entry.isDir && onOpenFileNewTab !== undefined && (
            <button type="button" onClick={() => { onOpenFileNewTab(menu.entry.path); setMenu(null) }}>{t('openFileNewTab')}</button>
          )}
          {!menu.entry.isDir && onOpenFileSide !== undefined && (
            <button type="button" onClick={() => { onOpenFileSide(menu.entry.path); setMenu(null) }}>{t('openFileSide')}</button>
          )}
          <button type="button" onClick={() => { onReferenceFile(menu.entry.path, menu.entry.isDir); setMenu(null) }}>{t('referenceFile')}</button>
          <button type="button" onClick={() => copyPath(menu.entry.path)}>{t('copyPaths')}</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
