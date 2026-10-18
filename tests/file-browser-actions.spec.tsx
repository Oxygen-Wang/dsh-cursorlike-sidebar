// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { act } from 'react-dom/test-utils'
import { FileGrid } from '../src/client/FileGrid.tsx'
import { FileColumns } from '../src/client/FileColumns.tsx'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { CURSORLIKE_DRAG } from '../src/client/cursorlike-interactions.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
const mocks = vi.hoisted(() => ({ fsTree: vi.fn(), fsRename: vi.fn(), fsRemove: vi.fn(), fsMkdir: vi.fn(), fsCreateFile: vi.fn(), fsTransfer: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ api: mocks, mediaUrl: () => '', downloadUrl: () => '/download' }))
vi.mock('../src/client/FileTree.tsx', () => ({ FileTree: () => null }))
const rows = [
  { path: '/ws/dest', name: 'dest', isDir: true, hidden: false, isSymlink: false, broken: false },
  { path: '/ws/a.ts', name: 'a.ts', isDir: false, hidden: false, isSymlink: false, broken: false },
  { path: '/ws/b.md', name: 'b.md', isDir: false, hidden: false, isSymlink: false, broken: false },
]
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const row = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`[data-cursorlike-path="${path}"]`)!
const key = (element: HTMLElement, name: string, init: KeyboardEventInit = {}) => {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}
const click = (element: HTMLElement, init: MouseEventInit = {}) => {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })) })
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  mocks.fsTree.mockResolvedValue({ path: '/ws', entries: rows, truncated: false })
  mocks.fsRename.mockResolvedValue({ path: '/ws/renamed.ts' })
  mocks.fsRemove.mockResolvedValue({ path: '/ws/a.ts' })
  mocks.fsTransfer.mockResolvedValue({ path: '/ws/dest/a.ts' })
})

describe.each(['grid', 'columns'] as const)('%s basic file interactions', kind => {
  function mount(overrides: Partial<ComponentProps<typeof FileGrid>> = {}) {
    const props = { sessionId: 's', cwd: '/ws', iconSize: 48, onIconSizeChange: () => {}, onOpenFile: vi.fn(), onReferenceFile: vi.fn(), ...overrides }
    return { ...renderRoot(kind === 'grid' ? createElement(FileGrid, props) : createElement(FileColumns, props)), props }
  }
  it('creates a file without automatically opening an editor', async () => {
    mocks.fsCreateFile.mockResolvedValue({ path: '/ws/created.txt' })
    const view = mount()
    await flush()
    key(row(view.container, '/ws/a.ts'), 'F10', { shiftKey: true })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'New file')!
    click(item)
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'created.txt')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(mocks.fsCreateFile).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws', 'created.txt')
    expect(view.props.onOpenFile).not.toHaveBeenCalled()
    view.unmount()
  })
  it('selects with modifiers without opening, ranges and selects all, references selected rows', async () => {
    const view = mount()
    await flush()
    click(row(view.container, '/ws/a.ts'), { ctrlKey: true })
    click(row(view.container, '/ws/b.md'), { shiftKey: true })
    expect(view.props.onOpenFile).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll('[data-dsh-selected="true"]')).toHaveLength(2)
    key(row(view.container, '/ws/a.ts'), 'l', { ctrlKey: true })
    expect(view.props.onReferenceFile).toHaveBeenCalledTimes(2)
    key(row(view.container, '/ws/a.ts'), 'a', { ctrlKey: true })
    expect(view.container.querySelectorAll('[data-dsh-selected="true"]')).toHaveLength(3)
    key(row(view.container, '/ws/a.ts'), 'Escape')
    expect(view.container.querySelectorAll('[data-dsh-selected="true"]')).toHaveLength(0)
    view.unmount()
  })
  it('renames through F2 and preserves the tab reconciliation callback', async () => {
    const renamed = vi.fn()
    const view = mount({ onPathRenamed: renamed })
    await flush()
    key(row(view.container, '/ws/a.ts'), 'F2')
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(input.value).toBe('a.ts')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'renamed.ts')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(mocks.fsRename).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws/a.ts', 'renamed.ts')
    expect(renamed).toHaveBeenCalledWith('/ws/a.ts', '/ws/renamed.ts')
    view.unmount()
  })
  it('asks before deletion and closes deleted tabs only after confirmation', async () => {
    const deleted = vi.fn()
    const view = mount({ onPathDeleted: deleted })
    await flush()
    key(row(view.container, '/ws/a.ts'), 'Delete')
    expect(mocks.fsRemove).not.toHaveBeenCalled()
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Delete selected')!
    click(button)
    await flush()
    expect(mocks.fsRemove).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws/a.ts')
    expect(deleted).toHaveBeenCalledWith('/ws/a.ts', false)
    view.unmount()
  })
  it('refreshes from the parent and applies type sorting', async () => {
    const view = mount({ refreshTick: 0 })
    await flush()
    const next = { ...view.props, refreshTick: 1, sort: { key: 'type' as const, dirsFirst: false } }
    view.rerender(kind === 'grid' ? createElement(FileGrid, next) : createElement(FileColumns, next))
    await flush()
    expect(mocks.fsTree).toHaveBeenCalledTimes(2)
    expect([...view.container.querySelectorAll<HTMLElement>('[data-cursorlike-path]')].map(element => element.dataset.cursorlikePath)).toEqual(['/ws/dest', '/ws/b.md', '/ws/a.ts'])
    view.unmount()
  })
  it('opens a keyboard context menu and offers file operations in the shared menu', async () => {
    const view = mount()
    await flush()
    key(row(view.container, '/ws/a.ts'), 'F10', { shiftKey: true })
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Rename')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Copy')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Cut')
    view.unmount()
  })
  it('moves focus with Home/End without opening files and protects names from shortcuts', async () => {
    const view = mount()
    await flush()
    key(row(view.container, '/ws/a.ts'), 'End')
    expect(document.activeElement).toBe(row(view.container, '/ws/b.md'))
    key(row(view.container, '/ws/b.md'), 'Home')
    expect(document.activeElement).toBe(row(view.container, '/ws/dest'))
    expect(view.props.onOpenFile).not.toHaveBeenCalled()
    key(row(view.container, '/ws/a.ts'), 'Escape')
    key(row(view.container, '/ws/a.ts'), 'F2')
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    key(input, 'Delete')
    expect(mocks.fsRemove).not.toHaveBeenCalled()
    expect(input.value).toBe('a.ts')
    view.unmount()
  })
  it('uploads OS files to the folder under the pointer', async () => {
    const upload = vi.fn()
    const view = mount({ onUploadRequest: upload })
    await flush()
    const file = new File(['contents'], 'upload.txt')
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], items: [], files: [file] } })
    act(() => { row(view.container, '/ws/dest').dispatchEvent(event) })
    await flush()
    expect(upload).toHaveBeenCalledWith('/ws/dest', [{ file, relativePath: 'upload.txt' }])
    view.unmount()
  })
})

describe('TreePanel transfers across file surfaces', () => {
  const panel = (renamed = vi.fn()) => renderRoot(createElement(TreePanel, {
    sessionId: 's', cwd: '/ws', expanded: [], revealed: [], onToggle: () => {}, onOpenFile: () => {}, onReferenceFile: () => {}, onPathRenamed: renamed,
  }))
  it('moves a nested file to the parent using the parent tile', async () => {
    const view = panel()
    await flush()
    click(row(view.container, '/ws/dest'))
    await flush()
    const parent = view.container.querySelector<HTMLElement>('[data-cursorlike-parent][data-cursorlike-drop-dir="/ws"]')!
    expect(parent).not.toBeNull()
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: {
      types: [CURSORLIKE_DRAG], getData: () => JSON.stringify({ version: 1, sessionId: 's', cwd: '/ws', paths: [{ path: '/ws/dest/a.ts', directory: false }] }),
    } })
    act(() => { parent.dispatchEvent(event) })
    await flush()
    expect(mocks.fsTransfer).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws/dest/a.ts', '/ws', 'move')
    view.unmount()
  })
  it('copies, cuts and pastes into the focused folder without hijacking text inputs', async () => {
    const renamed = vi.fn()
    const view = panel(renamed)
    await flush()
    key(row(view.container, '/ws/a.ts'), 'c', { ctrlKey: true })
    key(row(view.container, '/ws/dest'), 'v', { ctrlKey: true })
    await flush()
    expect(mocks.fsTransfer).toHaveBeenLastCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws/a.ts', '/ws/dest', 'copy')
    expect(renamed).not.toHaveBeenCalled()
    key(row(view.container, '/ws/a.ts'), 'x', { ctrlKey: true })
    key(row(view.container, '/ws/dest'), 'v', { ctrlKey: true })
    await flush()
    expect(renamed).toHaveBeenCalledWith('/ws/a.ts', '/ws/dest/a.ts')
    const search = view.container.querySelector('input')!
    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { search.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    view.unmount()
  })
  it.each([false, true])('drops references as a move or copy (Ctrl=%s)', async ctrlKey => {
    const view = panel()
    await flush()
    const transfer = { types: [CURSORLIKE_DRAG], getData: () => JSON.stringify({ version: 1, sessionId: 's', cwd: '/ws', paths: [{ path: '/ws/a.ts', directory: false }] }) }
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(event, { dataTransfer: { value: transfer }, ctrlKey: { value: ctrlKey } })
    act(() => { row(view.container, '/ws/dest').dispatchEvent(event) })
    await flush()
    expect(mocks.fsTransfer).toHaveBeenCalledWith({ sessionId: 's', cwd: '/ws' }, '/ws/a.ts', '/ws/dest', ctrlKey ? 'copy' : 'move')
    view.unmount()
  })
  it.each([
    { sessionId: 'foreign' }, { cwd: '/other' }, { lineStart: 2, lineEnd: 4 },
  ])('never moves a foreign scope or selected-text drag: %o', override => {
    return (async () => {
      const view = panel()
      await flush()
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: {
        types: [CURSORLIKE_DRAG], getData: () => JSON.stringify({ version: 1, sessionId: 's', cwd: '/ws', paths: [{ path: '/ws/a.ts', directory: false }], ...override }),
      } })
      act(() => { row(view.container, '/ws/dest').dispatchEvent(event) })
      await flush()
      expect(mocks.fsTransfer).not.toHaveBeenCalled()
      view.unmount()
    })()
  })
})
