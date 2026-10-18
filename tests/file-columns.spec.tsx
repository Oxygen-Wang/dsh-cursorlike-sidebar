/**
 * Miller-column file browser: a folder click appends a column, the columns
 * stay navigable, and a file click opens it. The host listing is mocked; the
 * component's only workspace call is `fs.tree`.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { FileColumns } from '../src/client/FileColumns.tsx'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTree } = vi.hoisted(() => ({ fsTree: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({
  api: { fsTree: (...args: unknown[]) => fsTree(...args) },
}))

const folder = { name: 'src', path: '/ws/src', isDir: true, hidden: false, isSymlink: false, broken: false }
const file = { name: 'readme.md', path: '/ws/readme.md', isDir: false, hidden: false, isSymlink: false, broken: false }

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('FileColumns', () => {
  it('appends a column when a folder is clicked and opens a file', async () => {
    fsTree.mockImplementation((_scope: unknown, dir: string) => Promise.resolve({
      path: dir,
      entries: dir === '/ws' ? [folder, file] : [{ ...file, name: 'main.ts', path: '/ws/src/main.ts' }],
      truncated: false,
    }))
    const opened: string[] = []
    const view = renderRoot(createElement(FileColumns, {
      sessionId: 's1', cwd: '/ws',
      onOpenFile: (path: string) => { opened.push(path) },
      onReferenceFile: () => {},
    }))
    await flush()
    expect(view.container.textContent).toContain('readme.md')

    const folderButton = [...view.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('src')) as HTMLButtonElement
    act(() => { folderButton.click() })
    await flush()
    expect(view.container.querySelectorAll('[data-file-column]')).toHaveLength(2)
    expect(view.container.textContent).toContain('main.ts')

    const fileButton = [...view.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('main.ts')) as HTMLButtonElement
    act(() => { fileButton.click() })
    expect(opened).toEqual(['/ws/src/main.ts'])
    view.unmount()
  })
})
