/** Miller columns keep the existing layout and share grid file actions. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type FsEntry } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { useFileBrowserActions, type FileBrowserActionsProps } from './file-browser-actions.tsx'
import { DEFAULT_FILE_TREE_SORT, sortEntries, type FileTreeSort } from './file-tree-sort.ts'
import { baseName, isWithinWorkspace } from './paths.ts'
import { IconButton } from './ui/index.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

function Column(props: FileBrowserActionsProps & {
  dir: string
  exclude?: readonly string[]
  visible?: boolean
  service?: BetterSidebarService
  active: boolean
  onEnter: (path: string) => void
  refreshTick: number
  sort?: FileTreeSort
}) {
  const { sessionId, cwd, dir, exclude, visible, service, active, onEnter, onOpenFile } = props
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const excludeKey = (exclude ?? []).join('\0')
  useEffect(() => {
    if (visible === false || cwd === undefined) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api.fsTree({ sessionId, cwd }, dir, excludeKey === '' ? undefined : excludeKey.split('\0'), controller.signal)
      .then(listing => {
        if (controller.signal.aborted) return
        setEntries(listing.entries)
        setTruncated(listing.truncated)
        setLoading(false)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setEntries([])
        setTruncated(false)
        setLoading(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => controller.abort()
  }, [sessionId, cwd, dir, excludeKey, visible, refreshTick, props.refreshTick])
  const sorted = useMemo(() => sortEntries(entries, props.sort ?? DEFAULT_FILE_TREE_SORT), [entries, props.sort])
  const open = (entry: FsEntry): void => { if (entry.isDir) onEnter(entry.path); else onOpenFile(entry.path) }
  const actions = useFileBrowserActions(props, dir, sorted, open, () => setRefreshTick(tick => tick + 1))
  const icon = (entry: FsEntry): ReactNode => entry.isDir
    ? service !== undefined ? service.folderIcon(entry.path, true, 16) : builtinFolderIcon(true, 16)
    : service !== undefined ? service.fileIcon(entry.path, 16) : builtinFileIcon(entry.path, 16)
  return (
    <div className={clsx(css.fileColumn, active && css.fileColumnActive)} data-file-column={dir} tabIndex={0}
      data-cursorlike-drop-dir={dir}
      onKeyDown={actions.keyDown} onContextMenu={event => actions.contextMenu(event)}
      onDragOver={actions.dragOver} onDrop={event => actions.drop(event)}>
      <div className={css.fileColumnHeader} title={dir}>{baseName(dir) || dir}</div>
      <div className={css.fileColumnList} onClick={event => { if (event.target === event.currentTarget) actions.clearSelection() }}>
        {loading && <div className={css.fileColumnHint}>{t('loading')}</div>}
        {!loading && error !== null && <div className={css.fileColumnError}>{error}</div>}
        {!loading && error === null && sorted.map(entry => (
          <button key={entry.path} type="button" draggable={!entry.broken}
            className={clsx(css.fileColumnItem, entry.hidden && css.explorerHidden, actions.selected.has(entry.path) && css.explorerRowSelected)}
            title={entry.path} data-cursorlike-path={entry.path} data-cursorlike-directory={entry.isDir ? 'true' : 'false'}
            {...actions.rowProps(entry)}>
            <span className={css.fileColumnIcon}>{icon(entry)}</span>
            <span className={css.fileColumnName}>{entry.name}</span>
          </button>
        ))}
        {!loading && error === null && entries.length === 0 && <div className={css.fileColumnHint}>{t('files')}</div>}
        {truncated && <div className={css.fileColumnHint}>{t('filesTruncated')}</div>}
      </div>
      {actions.controls}
    </div>
  )
}

export function FileColumns(props: FileBrowserActionsProps & {
  exclude?: readonly string[]
  visible?: boolean
  service?: BetterSidebarService
  refreshTick?: number
  sort?: FileTreeSort
}) {
  const { sessionId, cwd } = props
  const [columns, setColumns] = useState<string[]>(cwd === undefined ? [] : [cwd])
  const [refreshTick, setRefreshTick] = useState(0)
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setColumns(cwd === undefined ? [] : [cwd]) }, [sessionId, cwd])
  useEffect(() => {
    if (stripRef.current !== null) stripRef.current.scrollLeft = stripRef.current.scrollWidth
  }, [columns])
  const openColumn = (index: number, path: string): void => {
    if (cwd === undefined || !isWithinWorkspace(cwd, path)) return
    setColumns(current => [...current.slice(0, index + 1), path])
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || (event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return
    if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowLeft')) {
      event.preventDefault()
      setColumns(current => current.length > 1 ? current.slice(0, -1) : current)
    }
  }
  if (cwd === undefined) return null
  return (
    <div className={css.fileColumnsRoot} data-cursorlike-file-grid="" tabIndex={0} onKeyDown={keyDown}>
      <div className={css.fileColumnsHeader}>
        {columns.map((dir, index) => (
          <span key={dir} className={css.fileColumnsCrumb}>
            {index > 0 && <span className={css.fileColumnsSep}>/</span>}
            <button type="button" title={dir} onClick={() => setColumns(columns.slice(0, index + 1))}>{baseName(dir) || dir}</button>
          </span>
        ))}
        <IconButton label={t('refresh')} icon={<IconRefreshOutlineRegular size={14} />} onClick={() => setRefreshTick(tick => tick + 1)} />
      </div>
      <div className={css.fileColumnsStrip} ref={stripRef}>
        {columns.map((dir, index) => (
          <Column {...props} key={`${sessionId}-${dir}`} dir={dir}
            refreshTick={refreshTick + (props.refreshTick ?? 0)} active={index === columns.length - 1}
            onEnter={path => openColumn(index, path)} />
        ))}
      </div>
    </div>
  )
}
