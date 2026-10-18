/**
 * Desktop-style Files grid: the first tile is the parent/back action, folders
 * enter on click, files open, and the context menu reuses the caller's
 * open/reference actions. The host listing is mocked; the component's only
 * workspace call is `fs.tree`.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { FileGrid } from '../src/client/FileGrid.tsx'
import type { BetterSidebarService } from '../src/client/service.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTree } = vi.hoisted(() => ({ fsTree: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({
  api: { fsTree: (...args: unknown[]) => fsTree(...args) },
  mediaUrl: (_scope: unknown, path: string) => `/media?path=${encodeURIComponent(path)}`,
}))

const folder = { name: 'src', path: '/ws/src', isDir: true, hidden: false, isSymlink: false, broken: false }
const file = { name: 'readme.md', path: '/ws/readme.md', isDir: false, hidden: false, isSymlink: false, broken: false }
const image = { name: 'shot.png', path: '/ws/shot.png', isDir: false, hidden: false, isSymlink: false, broken: false }

/** Resolve after the listing's promise/act queue has drained. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('FileGrid', () => {
  it('starts with a disabled back tile at the root, enters a folder and returns', async () => {
    fsTree.mockImplementation((_scope: unknown, dir: string) => Promise.resolve({
      path: dir,
      entries: dir === '/ws' ? [folder, file] : [{ ...file, name: 'main.ts', path: '/ws/src/main.ts' }],
      truncated: false,
    }))
    const opened: string[] = []
    const view = renderRoot(createElement(FileGrid, {
      sessionId: 's1', cwd: '/ws', iconSize: 48, onIconSizeChange: () => {},
      onOpenFile: (path: string) => { opened.push(path) },
      onReferenceFile: () => {},
    }))
    await flush()

    const back = view.container.querySelector('button[title="Parent directory"]') as HTMLButtonElement | null
    expect(back).not.toBeNull()
    expect(back?.disabled).toBe(true)

    const folderButton = [...view.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('src')) as HTMLButtonElement
    act(() => { folderButton.click() })
    await flush()
    expect(fsTree.mock.calls.at(-1)?.[1]).toBe('/ws/src')
    expect(view.container.textContent).toContain('main.ts')

    const backNow = view.container.querySelector('button[title="Parent directory"]') as HTMLButtonElement
    act(() => { backNow.click() })
    await flush()
    expect(fsTree.mock.calls.at(-1)?.[1]).toBe('/ws')
    expect(view.container.textContent).toContain('readme.md')

    const fileButton = [...view.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('readme.md')) as HTMLButtonElement
    act(() => { fileButton.click() })
    expect(opened).toEqual(['/ws/readme.md'])
    view.unmount()
  })

  it('uses the service icon resolver for files and folders', async () => {
    fsTree.mockResolvedValue({ path: '/ws', entries: [folder, file], truncated: false })
    const service = {
      fileIcon: vi.fn(() => createElement('span', { 'data-file-icon': true })),
      folderIcon: vi.fn(() => createElement('span', { 'data-folder-icon': true })),
    } as unknown as BetterSidebarService
    const view = renderRoot(createElement(FileGrid, {
      sessionId: 's1', cwd: '/ws', service, iconSize: 48, onIconSizeChange: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
    await flush()
    expect(service.folderIcon).toHaveBeenCalledWith('/ws/src', true, 48)
    expect(service.fileIcon).toHaveBeenCalledWith('/ws/readme.md', 48)
    expect(view.container.querySelector('[data-folder-icon]')).not.toBeNull()
    expect(view.container.querySelector('[data-file-icon]')).not.toBeNull()
    view.unmount()
  })

  it('shows an image thumbnail once the Ctrl+wheel size is large enough', async () => {
    fsTree.mockResolvedValue({ path: '/ws', entries: [image], truncated: false })
    const view = renderRoot(createElement(FileGrid, {
      sessionId: 's1', cwd: '/ws', iconSize: 96, onIconSizeChange: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
    await flush()
    const thumbnail = view.container.querySelector('img[class*="fileGridThumb"]')
    expect(thumbnail).not.toBeNull()
    expect(thumbnail?.getAttribute('src')).toContain('shot.png')
    view.unmount()
  })
})
