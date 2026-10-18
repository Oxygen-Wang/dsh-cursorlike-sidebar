/** Shared interaction layer for the grid and each Miller column. */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Button, Menu, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry, type SessionScope } from './api.ts'
import { writeReferenceDrag } from './cursorlike-interactions.ts'
import { readFileClipboard, writeFileClipboard, type FileTransferMode } from './file-clipboard.ts'
import { relativeTo } from './paths.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './upload.ts'
import { ConfirmDialog } from './ui/index.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface FileBrowserActionsProps {
  sessionId: string
  cwd: string | undefined
  onOpenFile: (path: string) => void
  onOpenFileNewTab?: (path: string) => void
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string, isDir: boolean) => void
  onPathRenamed?: (oldPath: string, newPath: string) => void
  onPathDeleted?: (path: string, isDir: boolean) => void
  onUploadRequest?: (dir: string, items: UploadItem[]) => void
  busy?: boolean
  onBeforeRemove?: (paths: string[]) => boolean
  onTransferRequest?: (dir: string, paths: string[], mode: FileTransferMode) => void
}

export function useFileBrowserActions(
  props: FileBrowserActionsProps,
  dir: string | undefined,
  entries: readonly FsEntry[],
  open: (entry: FsEntry) => void,
  refresh: () => void,
  navigationColumns = 1,
) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const [menu, setMenu] = useState<{ entry?: FsEntry; x: number; y: number } | null>(null)
  const [edit, setEdit] = useState<{ kind: 'rename' | 'file' | 'folder'; path: string; value: string } | null>(null)
  const [removing, setRemoving] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const lock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const uploadDir = useRef<string | undefined>(undefined)
  const scopeKey = JSON.stringify([props.sessionId, props.cwd, dir])
  const liveKey = useRef(scopeKey)
  liveKey.current = scopeKey
  const generation = useRef(0)
  const scope: SessionScope = { sessionId: props.sessionId, cwd: props.cwd }
  const busy = working || props.busy === true

  useEffect(() => {
    generation.current += 1
    setSelected(new Set())
    anchor.current = null
    setMenu(null)
    setEdit(null)
    setRemoving(null)
    setError(null)
    lock.current = false
    setWorking(false)
    uploadDir.current = undefined
  }, [scopeKey])
  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => {
    const paths = new Set(entries.map(entry => entry.path))
    setSelected(current => [...current].every(path => paths.has(path)) ? current : new Set([...current].filter(path => paths.has(path))))
  }, [entries])

  const picked = (fallback?: FsEntry): FsEntry[] => {
    if (selected.size > 0 && (fallback === undefined || selected.has(fallback.path))) return entries.filter(entry => selected.has(entry.path))
    return fallback === undefined ? [] : [fallback]
  }
  const run = (operation: (active: () => boolean) => Promise<void>): void => {
    if (lock.current || props.busy === true || props.cwd === undefined) return
    const started = generation.current
    const key = scopeKey
    const active = (): boolean => generation.current === started && liveKey.current === key
    lock.current = true
    setWorking(true)
    setError(null)
    void operation(active).catch((failure: unknown) => {
      if (active()) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (!active()) return
      lock.current = false
      setWorking(false)
      refresh()
    })
  }
  const copyPaths = (rows: FsEntry[], relative: boolean): void => {
    run(async () => {
      const copied = await writeClipboard(rows.map(row => relative ? relativeTo(props.cwd ?? '', row.path) : row.path).join('\n'))
      if (!copied) throw new Error(t('jsonCopyFailed'))
    })
  }
  const contextMenu = (event: MouseEvent<HTMLElement>, entry?: FsEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus()
    if (entry !== undefined && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      anchor.current = entry.path
    } else if (entry === undefined) setSelected(new Set())
    setMenu({ entry, x: event.clientX, y: event.clientY })
  }
  const click = (event: MouseEvent<HTMLElement>, entry: FsEntry): void => {
    if (event.detail > 1) return
    setMenu(null)
    if (event.shiftKey) {
      const from = entries.findIndex(row => row.path === anchor.current)
      const to = entries.indexOf(entry)
      setSelected(new Set(entries.slice(from < 0 ? to : Math.min(from, to), from < 0 ? to + 1 : Math.max(from, to) + 1).map(row => row.path)))
      return
    }
    anchor.current = entry.path
    if (event.ctrlKey || event.metaKey) {
      setSelected(current => {
        const next = new Set(current)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      return
    }
    setSelected(new Set([entry.path]))
    if (!entry.broken) open(entry)
  }
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || (event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return
    const rowPath = (event.target as HTMLElement).closest<HTMLElement>('[data-cursorlike-path]')?.dataset.cursorlikePath
    const target = entries.find(entry => entry.path === rowPath)
    const rows = picked(target)
    const command = event.ctrlKey || event.metaKey
    if (!command && !event.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End', ...(navigationColumns > 1 ? ['ArrowLeft', 'ArrowRight'] : [])].includes(event.key)) {
      const current = entries.findIndex(entry => entry.path === rowPath)
      const delta = event.key === 'ArrowUp' ? -navigationColumns : event.key === 'ArrowDown' ? navigationColumns : event.key === 'ArrowLeft' ? -1 : 1
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, current < 0 ? 0 : current + delta))
      const next = entries[index]
      if (next === undefined) return
      if (event.shiftKey) {
        const start = Math.max(0, entries.findIndex(entry => entry.path === anchor.current))
        setSelected(new Set(entries.slice(Math.min(start, index), Math.max(start, index) + 1).map(entry => entry.path)))
      } else {
        anchor.current = next.path
        setSelected(new Set([next.path]))
      }
      const root = event.currentTarget
      const node = [...root.querySelectorAll<HTMLElement>('[data-cursorlike-path]')].find(node => node.dataset.cursorlikePath === next.path)
      node?.focus()
      node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      event.preventDefault(); event.stopPropagation()
      return
    }
    if (event.key === 'Escape') { setSelected(new Set()); setMenu(null); return }
    if (event.key === 'F5' && !command && !event.altKey && !event.shiftKey) refresh()
    else if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') setSelected(new Set(entries.map(entry => entry.path)))
    else if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l' && rows.length > 0) {
      for (const row of rows) props.onReferenceFile(row.path, row.isDir)
    } else if (!command && !event.altKey && !event.shiftKey && event.key === 'F2' && rows.length === 1 && !busy) {
      setEdit({ kind: 'rename', path: rows[0]!.path, value: rows[0]!.name })
    } else if (!command && !event.altKey && !event.shiftKey && event.key === 'Delete' && rows.length > 0 && !busy) setRemoving(rows)
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const rect = (event.target as HTMLElement).getBoundingClientRect()
      if (target !== undefined && !selected.has(target.path)) setSelected(new Set([target.path]))
      setMenu({ entry: target, x: rect.left, y: rect.bottom })
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  const uploadHere = (destination: string): void => {
    if (busy || props.onUploadRequest === undefined) return
    uploadDir.current = destination
    input.current?.click()
  }
  const dragOver = (event: DragEvent<HTMLElement>): void => {
    if (props.onUploadRequest === undefined || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }
  const drop = (event: DragEvent<HTMLElement>, destination = dir): void => {
    if (!event.dataTransfer.types.includes('Files') || destination === undefined || props.onUploadRequest === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const key = scopeKey
    const currentGeneration = generation.current
    void uploadItemsFromDrop(event.dataTransfer).then(items => {
      if (key === liveKey.current && currentGeneration === generation.current) props.onUploadRequest?.(destination, items)
    }).catch(failure => { if (key === liveKey.current) setError(String(failure)) })
  }
  const targetDir = menu?.entry?.isDir === true ? menu.entry.path : dir
  const menuRows = picked(menu?.entry)
  const controls = <>
    {error !== null && <div className={css.explorerActionError} role="alert">{error}</div>}
    {selected.size > 0 && <div className={css.explorerSelectionBar} role="toolbar" aria-label={t('filesSelected', { count: selected.size })}>
      <span>{t('filesSelected', { count: selected.size })}</span>
      <button type="button" disabled={busy} onClick={() => copyPaths(picked(), false)}>{t('copyPaths')}</button>
      <button type="button" disabled={busy} onClick={() => setRemoving(picked())}>{t('deleteSelected')}</button>
      <button type="button" onClick={() => setSelected(new Set())}>{t('clearSelection')}</button>
    </div>}
    <input ref={input} type="file" multiple hidden onChange={event => {
      const destination = uploadDir.current
      if (destination !== undefined && !busy) props.onUploadRequest?.(destination, uploadItemsFromFiles(event.target.files ?? []))
      event.target.value = ''
    }} />
    <Menu open={menu !== null} onClose={() => setMenu(null)} portal compact align="start"
      getAnchorRect={() => menu === null ? null : new DOMRect(menu.x, menu.y, 0, 0)} anchor={<span />}
      items={[
        ...(menu?.entry === undefined ? [] : [
          { id: 'open', label: t('openEditor') },
          ...(!menu.entry.isDir && props.onOpenFileNewTab !== undefined ? [{ id: 'tab', label: t('openFileNewTab') }] : []),
          ...(!menu.entry.isDir && props.onOpenFileSide !== undefined ? [{ id: 'side', label: t('openFileSide') }] : []),
          { id: 'reference', label: t('referenceFile') },
          { id: 'relative', label: t('copyRelative') },
          { id: 'absolute', label: t('copyAbsolute') },
          { id: 'copy-file', label: t('copy'), disabled: busy },
          { id: 'cut-file', label: t('cut'), disabled: busy },
          ...(!menu.entry.isDir ? [{ id: 'download', label: t('download') }] : []),
          { id: 'rename', label: t('rename'), disabled: busy || menuRows.length !== 1 },
          { id: 'delete', label: t('delete'), danger: true, disabled: busy },
        ]),
        { id: 'new-file', label: t('newFile'), disabled: busy || targetDir === undefined },
        { id: 'paste-file', label: t('paste'), disabled: busy || props.onTransferRequest === undefined || !readFileClipboard(scope)?.paths.length },
        { id: 'new-folder', label: t('newFolder'), disabled: busy || targetDir === undefined },
        ...(props.onUploadRequest === undefined ? [] : [{ id: 'upload', label: t('uploadHere'), disabled: busy }]),
        { id: 'refresh', label: t('refresh') },
      ]}
      onSelect={id => {
        const target = menu?.entry
        setMenu(null)
        if (id === 'refresh') refresh()
        else if (id === 'paste-file') {
          const value = readFileClipboard(scope)
          if (value !== undefined && targetDir !== undefined) props.onTransferRequest?.(targetDir, value.paths, value.mode)
        }
        else if (id === 'new-file' || id === 'new-folder') { if (targetDir !== undefined) setEdit({ kind: id === 'new-file' ? 'file' : 'folder', path: targetDir, value: '' }) }
        else if (id === 'upload') { if (targetDir !== undefined) uploadHere(targetDir) }
        else if (target !== undefined) {
          if (id === 'open') open(target)
          else if (id === 'tab') props.onOpenFileNewTab?.(target.path)
          else if (id === 'side') props.onOpenFileSide?.(target.path)
          else if (id === 'reference') { for (const row of menuRows) props.onReferenceFile(row.path, row.isDir) }
          else if (id === 'copy-file' || id === 'cut-file') writeFileClipboard(scope, menuRows.map(row => row.path), id === 'cut-file' ? 'move' : 'copy')
          else if (id === 'relative' || id === 'absolute') copyPaths(menuRows, id === 'relative')
          else if (id === 'download') {
            const link = document.createElement('a')
            link.href = downloadUrl(scope, target.path)
            link.download = target.name
            link.click()
          } else if (id === 'rename') setEdit({ kind: 'rename', path: target.path, value: target.name })
          else if (id === 'delete') setRemoving(menuRows)
        }
      }} />
    <Modal open={edit !== null} onClose={() => { if (!busy) setEdit(null) }}
      title={t(edit?.kind === 'rename' ? 'rename' : edit?.kind === 'folder' ? 'newFolder' : 'newFile')} closeLabel={t('cancel')}>
      {edit !== null && <form onSubmit={event => {
        event.preventDefault()
        const pending = edit
        if (!pending.value.trim()) return
        run(async active => {
          const result = pending.kind === 'rename' ? await api.fsRename(scope, pending.path, pending.value)
            : pending.kind === 'folder' ? await api.fsMkdir(scope, pending.path, pending.value)
              : await api.fsCreateFile(scope, pending.path, pending.value)
          if (!active()) return
          if (pending.kind === 'rename') props.onPathRenamed?.(pending.path, result.path)
          setEdit(null)
          setSelected(new Set([result.path]))
        })
      }}>
        <input autoFocus aria-label={t(edit.kind === 'folder' ? 'newFolderPlaceholder' : 'newFilePlaceholder')}
          value={edit.value} disabled={busy} onChange={event => setEdit({ ...edit, value: event.target.value })}
          onFocus={event => { const dot = event.target.value.lastIndexOf('.'); event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length) }} />
        {error !== null && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy || !edit.value.trim()}>{t(edit.kind === 'rename' ? 'rename' : edit.kind === 'folder' ? 'newFolder' : 'newFile')}</Button>
      </form>}
    </Modal>
    <ConfirmDialog open={removing !== null} title={t('deleteSelectedTitle', { count: removing?.length ?? 0 })}
      description={t('fileDeleteRecoverable')} confirmLabel={t('deleteSelected')} cancelLabel={t('cancel')} busy={busy}
      onClose={() => { if (!busy) setRemoving(null) }} onConfirm={() => {
        const pending = removing
        if (pending === null) return
        if (props.onBeforeRemove?.(pending.map(row => row.path)) === false) { setRemoving(null); return }
        const group = pending.length > 1 ? crypto.randomUUID() : undefined
        run(async active => {
          for (const row of pending) {
            if (!active()) return
            await (group === undefined ? api.fsRemove(scope, row.path) : api.fsRemove(scope, row.path, group))
            if (!active()) return
            props.onPathDeleted?.(row.path, row.isDir)
            setRemoving(current => current?.filter(item => item.path !== row.path) ?? null)
            setSelected(current => new Set([...current].filter(path => path !== row.path)))
          }
          setRemoving(null)
        })
      }} />
  </>
  return {
    selected, controls, keyDown, contextMenu, dragOver, drop,
    rowProps: (entry: FsEntry) => ({
      'data-dsh-selected': selected.has(entry.path) ? 'true' : undefined,
      'aria-pressed': selected.has(entry.path),
      onClick: (event: MouseEvent<HTMLElement>) => click(event, entry),
      onContextMenu: (event: MouseEvent<HTMLElement>) => contextMenu(event, entry),
      onDragStart: (event: DragEvent<HTMLElement>) => {
        writeReferenceDrag(event.dataTransfer, scope, picked(entry).map(row => ({ path: row.path, directory: row.isDir })))
      },
      onDragOver: dragOver,
      onDrop: (event: DragEvent<HTMLElement>) => drop(event, entry.isDir ? entry.path : dir),
    }),
    clearSelection: () => setSelected(new Set()),
  }
}
