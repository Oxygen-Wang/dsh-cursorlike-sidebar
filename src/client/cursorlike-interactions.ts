/** CursorLike drag references, isolated by originating DSH session. */
import type { Context } from '../context-types.ts'
import type { BetterSidebarService, SessionScope } from './service.ts'
import { appendToDraft, insertWorkspaceReference, mentionFor } from './conversation-draft.ts'
import { relativeTo } from './paths.ts'

export const CURSORLIKE_DRAG = 'application/x-cursorlike-context'

export interface CursorlikeDrag {
  version: 1
  sessionId: string
  cwd?: string
  paths: { path: string; directory: boolean }[]
  text?: string
}

/** Emit both a typed reference and an ordinary text fallback. */
export function writeReferenceDrag(transfer: DataTransfer, scope: SessionScope, paths: CursorlikeDrag['paths']): void {
  const value: CursorlikeDrag = { version: 1, sessionId: scope.sessionId, cwd: scope.cwd, paths }
  transfer.setData(CURSORLIKE_DRAG, JSON.stringify(value))
  transfer.setData('text/plain', paths.map(item => mentionFor(scope.cwd ? relativeTo(scope.cwd, item.path) : item.path, item.directory ? 'folder' : 'file')?.mention || item.path).join(' '))
  transfer.effectAllowed = 'copy'
}

/** Keep the ordinary selected text intact for drags inside the editor itself. */
export function writeSelectionDrag(transfer: DataTransfer, sessionId: string, text: string): void {
  transfer.setData(CURSORLIKE_DRAG, JSON.stringify({ version: 1, sessionId, paths: [], text } satisfies CursorlikeDrag))
  if (!transfer.getData('text/plain')) transfer.setData('text/plain', text)
}

export function readCursorlikeDrag(transfer: DataTransfer): CursorlikeDrag | undefined {
  const raw = transfer.getData(CURSORLIKE_DRAG)
  if (!raw || raw.length > 200_000) return undefined
  try {
    const value = JSON.parse(raw) as Partial<CursorlikeDrag> | null
    if (!value || typeof value !== 'object') return undefined
    if (value.version !== 1 || typeof value.sessionId !== 'string' || !Array.isArray(value.paths) || value.paths.length > 1000) return undefined
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return undefined
    if (value.text !== undefined && typeof value.text !== 'string') return undefined
    if (!value.paths.every(item => item && typeof item.path === 'string' && typeof item.directory === 'boolean')) return undefined
    return value as CursorlikeDrag
  } catch {
    return undefined
  }
}

/** Product-owned composer and panel drop zones; never mutates a draft through DOM. */
export function installCursorlikeDrop(ctx: Context, service: Pick<BetterSidebarService, 'getSnapshot' | 'openFile' | 'openTab'>, doc: Document = document): () => void {
  const zone = (target: EventTarget | null): 'composer' | 'panel' | undefined => {
    if (!(target instanceof Element)) return undefined
    if (target.closest('[data-composer-input],[data-composer-card],[data-composer-seat]')) return 'composer'
    if (target.closest('[data-cursorlike-drop]')) return 'panel'
    return undefined
  }
  const onOver = (event: DragEvent): void => {
    if (!zone(event.target) || !event.dataTransfer?.types.includes(CURSORLIKE_DRAG)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent): void => {
    const destination = zone(event.target)
    if (!destination || !event.dataTransfer) return
    const value = readCursorlikeDrag(event.dataTransfer)
    if (!value) return
    event.preventDefault()
    event.stopPropagation()
    const sessionId = service.getSnapshot().sessionId
    // A retained background tab cannot drop a captured payload into another session's draft.
    if (!sessionId || value.sessionId !== sessionId) return
    if (destination === 'composer') {
      if (value.text) appendToDraft(ctx, sessionId, value.text)
      else for (const item of value.paths) insertWorkspaceReference(ctx, sessionId, item.path, item.directory)
    } else {
      const scope: SessionScope = { sessionId, cwd: value.cwd }
      for (const item of value.paths) {
        if (item.directory) service.openTab({ type: 'editor', path: item.path, meta: { dir: true } }, scope)
        else service.openFile(scope, item.path)
      }
    }
  }
  doc.addEventListener('dragover', onOver, true)
  doc.addEventListener('drop', onDrop, true)
  return () => { doc.removeEventListener('dragover', onOver, true); doc.removeEventListener('drop', onDrop, true) }
}
