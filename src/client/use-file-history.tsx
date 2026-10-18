/** One undo surface shared by all three explorer presentations. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { VscDiscard, VscHistory, VscRedo } from 'react-icons/vsc'
import { api, type SessionScope } from './api.ts'
import type { FileHistoryEffect, FileHistoryState, FileHistorySummary } from '../file-history-types.ts'
import { baseName } from './paths.ts'
import { t } from './locales.ts'
import { IconButton } from './ui/index.ts'
import css from './sidebar.module.css'

const empty = (): FileHistoryState => ({ undo: null, redo: null, undoCount: 0, redoCount: 0, entries: [] })
const title = (step: FileHistorySummary): string => {
  const action = step.kind === 'move' ? t('fileHistoryMove') : step.kind === 'file' ? t('newFile')
    : step.kind === 'folder' ? t('newFolder') : t(step.kind)
  return `${action} ${baseName(step.paths[0] ?? '')}${step.paths.length > 1 ? ` (+${step.paths.length - 1})` : ''}`
}
interface Notice extends SessionScope { direction?: 'undo' | 'redo'; action?: FileHistorySummary; silent?: boolean }

export function useFileHistory(scope: SessionScope, onEffect: (effect: FileHistoryEffect) => void, blocked = false,
  beforeReplay?: (step: FileHistorySummary, direction: 'undo' | 'redo') => boolean) {
  const [state, setState] = useState<FileHistoryState>(empty)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(0)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const pendingRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ direction?: 'undo' | 'redo'; action: FileHistorySummary } | null>(null)
  const [open, setOpen] = useState(false)
  const lock = useRef(false)
  const sequence = useRef(0)
  const activeScope = JSON.stringify([scope.sessionId, scope.cwd])
  const latestScope = useRef(activeScope)
  latestScope.current = activeScope
  const generation = useRef(0)
  const callback = useRef(onEffect)
  callback.current = onEffect
  const currentScope = useRef(scope)
  currentScope.current = scope
  const refresh = useCallback(async (notice?: Notice): Promise<void> => {
    if (typeof api.fsHistory !== 'function' || currentScope.current.cwd === undefined) return
    const request = ++sequence.current
    const key = latestScope.current
    loadingRef.current = true
    setLoading(true)
    try {
      const result = await api.fsHistory(currentScope.current)
      if (request !== sequence.current || key !== latestScope.current) return
      setState(result)
      if (notice !== undefined && notice.silent !== true) {
        setError(null)
        const action = notice.action ?? result.undo
        if (action !== null) setMessage({ direction: notice.direction, action })
      }
    } catch (failure) {
      if (request === sequence.current && key === latestScope.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (request === sequence.current && key === latestScope.current) { loadingRef.current = false; setLoading(false) }
    }
  }, [])
  useEffect(() => {
    generation.current += 1
    setState(empty()); setMessage(null); setError(null); setBusy(false); setOpen(false); setPending(0)
    pendingRef.current = 0
    loadingRef.current = false
    setLoading(false)
    lock.current = false
    void refresh()
    const changed = (event: Event): void => {
      const notice = (event as CustomEvent<Notice>).detail
      if (notice?.sessionId === scope.sessionId && notice.cwd === scope.cwd) void refresh(notice)
    }
    window.addEventListener('dsh-sidebar:file-history', changed)
    const mutationBusy = (event: Event): void => {
      const notice = (event as CustomEvent<Notice & { delta: number }>).detail
      if (notice?.sessionId !== scope.sessionId || notice.cwd !== scope.cwd) return
      pendingRef.current = Math.max(0, pendingRef.current + notice.delta)
      setPending(pendingRef.current)
    }
    window.addEventListener('dsh-sidebar:file-busy', mutationBusy)
    return () => {
      generation.current += 1; sequence.current += 1
      window.removeEventListener('dsh-sidebar:file-history', changed)
      window.removeEventListener('dsh-sidebar:file-busy', mutationBusy)
    }
  }, [scope.sessionId, scope.cwd, refresh])

  const replay = (direction: 'undo' | 'redo'): void => {
    const action = state[direction]
    if (blocked || loadingRef.current || pendingRef.current > 0 || lock.current || action === null || scope.cwd === undefined) return
    if (beforeReplay?.(action, direction) === false) { setError(t('fileHistoryUnsaved')); return }
    const started = generation.current
    const key = activeScope
    const active = (): boolean => started === generation.current && key === latestScope.current
    lock.current = true
    sequence.current += 1
    setBusy(true); setError(null)
    void (direction === 'undo' ? api.fsUndo(scope, action.id) : api.fsRedo(scope, action.id)).then(result => {
      if (!active()) return
      for (const effect of result.effects) callback.current(effect)
      setState(result.state)
      if (result.error !== undefined) setError(result.error)
      else setMessage({ direction, action })
      window.dispatchEvent(new CustomEvent('dsh-sidebar:refresh-files'))
      window.dispatchEvent(new CustomEvent('dsh-sidebar:file-history', { detail: { ...scope, ...(result.error === undefined ? { direction, action } : { silent: true }) } }))
    }).catch((failure: unknown) => {
      if (active()) { setError(failure instanceof Error ? failure.message : String(failure)); void refresh() }
    }).finally(() => {
      if (active()) { lock.current = false; setBusy(false) }
    })
  }
  const undo = (): void => replay('undo')
  const redo = (): void => replay('redo')
  const undoLabel = `${t('fileUndo')}${state.undo === null ? '' : `: ${title(state.undo)}`} (Ctrl/Cmd+Z)`
  const redoLabel = `${t('fileRedo')}${state.redo === null ? '' : `: ${title(state.redo)}`} (Ctrl/Cmd+Shift+Z / Ctrl+Y)`
  const locked = blocked || loading || busy || pending > 0
  return {
    busy: loading || busy || pending > 0, undo, redo, canUndo: state.undo !== null, canRedo: state.redo !== null,
    toolbar: <>
      <IconButton label={t('fileUndo')} title={undoLabel} icon={<VscDiscard size={14} />} disabled={locked || state.undo === null} onClick={undo} />
      <IconButton label={t('fileRedo')} title={redoLabel} icon={<VscRedo size={14} />} disabled={locked || state.redo === null} onClick={redo} />
      <IconButton label={t('fileHistory')} icon={<VscHistory size={14} />} onClick={() => setOpen(true)} />
    </>,
    feedback: <>
      {error !== null && <div className={css.fileHistoryNotice} role="alert"><span>{error}</span><button type="button" onClick={() => { setError(null); void refresh() }}>{t('refresh')}</button></div>}
      {message !== null && <div className={css.fileHistoryNotice} role="status" aria-live="polite">
        <span>{t(message.direction === 'undo' ? 'fileHistoryUndone' : message.direction === 'redo' ? 'fileHistoryRedone' : 'fileHistoryApplied', { action: title(message.action) })}</span>
        <button type="button" disabled={locked || (message.direction === 'undo' ? state.redo === null : state.undo === null)} onClick={message.direction === 'undo' ? redo : undo}>{t(message.direction === 'undo' ? 'fileRedo' : 'fileUndo')}</button>
      </div>}
      <Modal open={open} onClose={() => setOpen(false)} title={t('fileHistory')} closeLabel={t('close')}>
        <div className={css.fileHistoryButtons}>
          <button type="button" disabled={locked || state.undo === null} onClick={undo}>{t('fileUndo')} ({state.undoCount})</button>
          <button type="button" disabled={locked || state.redo === null} onClick={redo}>{t('fileRedo')} ({state.redoCount})</button>
        </div>
        <p>{t('fileHistoryKeys')}</p>
        {state.entries.length === 0 && <p>{t('fileHistoryEmpty')}</p>}
        <ol className={css.fileHistoryList}>{state.entries.map(entry => <li key={entry.id} data-undone={entry.undone ? 'true' : undefined}>
          <span title={entry.paths.join('\n')}>{title(entry)}</span>
          <time>{new Date(entry.time).toLocaleTimeString()}</time>
        </li>)}</ol>
      </Modal>
    </>,
  }
}
