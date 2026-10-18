// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import type { FileHistoryState } from '../src/file-history-types.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { clearEditorDirty, setEditorDirty } from '../src/client/editor-dirty.ts'

setupReactAct()
const mocks = vi.hoisted(() => ({ fsHistory: vi.fn(), fsUndo: vi.fn(), fsRedo: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ api: mocks }))
vi.mock('../src/client/FileGrid.tsx', () => ({ FileGrid: () => createElement('button', { 'data-file-area': true }, 'file') }))
vi.mock('../src/client/FileTree.tsx', () => ({ FileTree: () => null }))
vi.mock('../src/client/FileColumns.tsx', () => ({ FileColumns: () => null }))
const step = { id: 'step-1', kind: 'rename' as const, paths: ['/ws/a.ts'], time: 10 }
const done: FileHistoryState = { undo: step, redo: null, undoCount: 1, redoCount: 0, entries: [{ ...step, undone: false }] }
const undone: FileHistoryState = { undo: null, redo: step, undoCount: 0, redoCount: 1, entries: [{ ...step, undone: true }] }
const empty: FileHistoryState = { undo: null, redo: null, undoCount: 0, redoCount: 0, entries: [] }
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
function mount(sessionId = 's', renamed = vi.fn()) {
  const props = { sessionId, cwd: '/ws', expanded: [], revealed: [], onToggle: () => {}, onOpenFile: vi.fn(), onReferenceFile: () => {}, onPathRenamed: renamed }
  return { ...renderRoot(createElement(TreePanel, props)), props }
}
function key(element: HTMLElement, name: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, ctrlKey: true, shiftKey, bubbles: true, cancelable: true })
  act(() => { element.dispatchEvent(event) })
  return event
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  mocks.fsHistory.mockResolvedValue(done)
  mocks.fsUndo.mockImplementation(async () => {
    mocks.fsHistory.mockResolvedValue(undone)
    return { state: undone, effects: [{ type: 'move', from: '/ws/b.ts', path: '/ws/a.ts', isDir: false }] }
  })
  mocks.fsRedo.mockImplementation(async () => { mocks.fsHistory.mockResolvedValue(done); return { state: done, effects: [] } })
})

describe('file operation undo surface', () => {
  it('restores a deleted file without opening a new editor tab', async () => {
    mocks.fsUndo.mockResolvedValue({ state: undone, effects: [{ type: 'restore', path: '/ws/a.ts', isDir: false }] })
    const view = mount()
    await flush()
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    await flush()
    expect(mocks.fsUndo).toHaveBeenCalledTimes(1)
    expect(view.props.onOpenFile).not.toHaveBeenCalled()
    view.unmount()
  })
  it('loads persistent history and exposes undo, redo and recent operations', async () => {
    const view = mount()
    await flush()
    const undo = view.container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!
    expect(undo.disabled).toBe(false)
    expect(undo.title).toContain('a.ts')
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')!.disabled).toBe(true)
    act(() => { view.container.querySelector<HTMLButtonElement>('button[aria-label="File operation history"]')!.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('a.ts')
    view.unmount()
  })
  it.each(['shift-z', 'y'])('routes file shortcuts through history and reconciles paths; redo=%s', redoKey => {
    return (async () => {
      const renamed = vi.fn()
      const view = mount('s', renamed)
      await flush()
      const file = view.container.querySelector<HTMLElement>('[data-file-area]')!
      expect(key(file, 'z').defaultPrevented).toBe(true)
      await flush()
      expect(mocks.fsUndo).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, 'step-1')
      expect(renamed).toHaveBeenCalledWith('/ws/b.ts', '/ws/a.ts')
      expect(view.container.querySelector('[role="status"]')?.textContent).toContain('Undone')
      key(file, redoKey === 'y' ? 'y' : 'z', redoKey === 'shift-z')
      await flush()
      expect(mocks.fsRedo).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, 'step-1')
      view.unmount()
    })()
  })
  it('keeps text undo in inputs and ignores repeat clicks while replaying', async () => {
    let resolve!: (value: unknown) => void
    mocks.fsUndo.mockReturnValue(new Promise(value => { resolve = value }))
    const view = mount()
    await flush()
    expect(key(view.container.querySelector('input')!, 'z').defaultPrevented).toBe(false)
    const file = view.container.querySelector<HTMLElement>('[data-file-area]')!
    key(file, 'z'); key(file, 'z')
    expect(mocks.fsUndo).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ state: undone, effects: [] }); await Promise.resolve() })
    view.unmount()
  })
  it('shows conflicts and keeps undo available for retry', async () => {
    mocks.fsUndo.mockResolvedValue({ state: done, effects: [], error: 'destination already exists' })
    const view = mount()
    await flush()
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    await flush()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('already exists')
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(false)
    view.unmount()
  })
  it('blocks file removal undo until an unsaved draft has been saved', async () => {
    const created = { ...step, kind: 'file' as const }
    mocks.fsHistory.mockResolvedValue({ ...done, undo: created, entries: [{ ...created, undone: false }] })
    setEditorDirty('editor-1', true, 's', '/ws/a.ts')
    const view = mount()
    await flush()
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    expect(mocks.fsUndo).not.toHaveBeenCalled()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('unsaved edits')
    clearEditorDirty('editor-1', 's')
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    await flush()
    expect(mocks.fsUndo).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  it('disables replay while another file mutation is still in flight', async () => {
    const view = mount()
    await flush()
    act(() => { window.dispatchEvent(new CustomEvent('dsh-sidebar:file-busy', { detail: { sessionId: 's', cwd: '/ws', delta: 1 } })) })
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    expect(mocks.fsUndo).not.toHaveBeenCalled()
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(true)
    act(() => { window.dispatchEvent(new CustomEvent('dsh-sidebar:file-busy', { detail: { sessionId: 's', cwd: '/ws', delta: -1 } })) })
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    await flush()
    expect(mocks.fsUndo).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  it('does not apply a previous session result after switching scopes', async () => {
    let resolve!: (value: unknown) => void
    mocks.fsUndo.mockReturnValue(new Promise(value => { resolve = value }))
    const renamed = vi.fn()
    const view = mount('s', renamed)
    await flush()
    key(view.container.querySelector<HTMLElement>('[data-file-area]')!, 'z')
    mocks.fsHistory.mockResolvedValue(empty)
    view.rerender(createElement(TreePanel, { ...view.props, sessionId: 'other' }))
    await flush()
    await act(async () => { resolve({ state: undone, effects: [{ type: 'move', from: '/ws/b.ts', path: '/ws/a.ts', isDir: false }] }); await Promise.resolve() })
    expect(renamed).not.toHaveBeenCalled()
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(true)
    view.unmount()
  })
})
