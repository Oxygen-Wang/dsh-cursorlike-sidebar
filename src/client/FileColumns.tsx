/**
 * Miller-column file browser: each folder click appends a column, so several
 * directory levels stay visible side by side (the "multi-file-column" view).
 * It shares the host's listing/exclude contract with the tree and grid; only
 * the layout is different.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { api, type FsEntry, type SessionScope } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { writeReferenceDrag } from './cursorlike-interactions.ts'
import { baseName, isWithinWorkspace } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface ColumnMenuState {
  entry: FsEntry
  x: number
  y: number
  columnIndex: number
}

/** One directory level in the column strip. */
function Column(props: {
  sessionId: string
  cwd: string
  dir: string
  exclude?: readonly string[]
  visible?: boolean
  service?: BetterSidebarService
  active: boolean
  onEnter: (path: string) => void
  onOpenFile: (path: string) => void
  onMenu: (entry: FsEntry, x: number, y: number) => void
}) {
  const { sessionId, cwd, dir, exclude, visible, service, active, onEnter, onOpenFile, onMenu } = props
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const excludeKey = (exclude ?? []).join('\0')

  useEffect(() => {
    if (visible === false) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api.fsTree({ sessionId, cwd }, dir, excludeKey === '' ? undefined : excludeKey.split('\0'), controller.signal)
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
  }, [sessionId, cwd, dir, excludeKey, visible])

  const icon = (entry: FsEntry): ReactNode => entry.isDir
    ? service !== undefined ? service.folderIcon(entry.path, true, 16) : builtinFolderIcon(true, 16)
    : service !== undefined ? service.fileIcon(entry.path, 16) : builtinFileIcon(entry.path, 16)

  return (
    <div className={clsx(css.fileColumn, active && css.fileColumnActive)} data-file-column={dir}>
      <div className={css.fileColumnHeader} title={dir}>{baseName(dir) || dir}</div>
      <div className={css.fileColumnList}>
        {loading && <div className={css.fileColumnHint}>{t('loading')}</div>}
        {!loading && error !== null && <div className={css.fileColumnError}>{error}</div>}
        {!loading && error === null && entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            draggable={!entry.broken}
            className={clsx(css.fileColumnItem, entry.hidden && css.explorerHidden)}
            title={entry.path}
            data-cursorlike-path={entry.path}
            data-cursorlike-directory={entry.isDir ? 'true' : 'false'}
            onClick={() => {
              if (entry.isDir) onEnter(entry.path)
              else onOpenFile(entry.path)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onMenu(entry, event.clientX, event.clientY)
            }}
            onDragStart={(event: DragEvent<HTMLButtonElement>) => {
              const scope: SessionScope = { sessionId, cwd }
              writeReferenceDrag(event.dataTransfer, scope, [{ path: entry.path, directory: entry.isDir }])
            }}
          >
            <span className={css.fileColumnIcon}>{icon(entry)}</span>
            <span className={css.fileColumnName}>{entry.name}</span>
          </button>
        ))}
        {!loading && error === null && entries.length === 0 && <div className={css.fileColumnHint}>{t('files')}</div>}
        {truncated && <div className={css.fileColumnHint}>{t('filesTruncated')}</div>}
      </div>
    </div>
  )
}

export function FileColumns(props: {
  sessionId: string
  cwd: string | undefined
  exclude?: readonly string[]
  visible?: boolean
  service?: BetterSidebarService
  onOpenFile: (path: string) => void
  onOpenFileNewTab?: (path: string) => void
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string, isDir: boolean) => void
}) {
  const { sessionId, cwd, exclude, visible, service, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile } = props
  const [columns, setColumns] = useState<string[]>(cwd === undefined ? [] : [cwd])
  const [menu, setMenu] = useState<ColumnMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setColumns(cwd === undefined ? [] : [cwd])
  }, [cwd])

  useEffect(() => {
    if (stripRef.current !== null) stripRef.current.scrollLeft = stripRef.current.scrollWidth
  }, [columns])

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

  const openColumn = (index: number, path: string): void => {
    if (cwd === undefined || !isWithinWorkspace(cwd, path)) return
    setColumns((current) => {
      const next = current.slice(0, index + 1)
      if (next[next.length - 1] !== path) next.push(path)
      return next
    })
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).catch(() => { /* clipboard unavailable */ })
    setMenu(null)
  }

  const crumbs = useMemo(() => columns.map((dir, index) => ({
    label: baseName(dir) || dir,
    index,
  })), [columns])

  if (cwd === undefined) return null
  return (
    <div className={css.fileColumnsRoot} data-cursorlike-file-grid="">
      <div className={css.fileColumnsHeader}>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className={css.fileColumnsCrumb}>
            {index > 0 && <span className={css.fileColumnsSep}>/</span>}
            <button type="button" onClick={() => setColumns(columns.slice(0, index + 1))}>{crumb.label}</button>
          </span>
        ))}
      </div>
      <div className={css.fileColumnsStrip} ref={stripRef}>
        {columns.map((dir, index) => (
          <Column
            key={`${dir}-${index}`}
            sessionId={sessionId}
            cwd={cwd}
            dir={dir}
            exclude={exclude}
            visible={visible}
            service={service}
            active={index === columns.length - 1}
            onEnter={(path) => openColumn(index, path)}
            onOpenFile={onOpenFile}
            onMenu={(entry, x, y) => setMenu({ entry, x, y, columnIndex: index })}
          />
        ))}
      </div>
      {menu !== null && createPortal(
        <div ref={menuRef} className={css.fileGridMenu} style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { if (menu.entry.isDir) openColumn(menu.columnIndex, menu.entry.path); else onOpenFile(menu.entry.path); setMenu(null) }}>
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
