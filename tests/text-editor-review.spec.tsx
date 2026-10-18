/**
 * The editor's inline review bar: a content reload from the host (agent edit)
 * shows Keep / Revert, Keep drops the bar, Revert writes the old bytes back,
 * and either decision can be undone inside the short window.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

const fsWrite = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, fsWrite: (...args: unknown[]) => fsWrite(...args) } }
})

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a.ts',
    title: 'a.ts',
    viewerId: 'code',
    content: 'const a = 1\n',
    mtimeMs: 123,
    ...overrides,
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label)) as HTMLButtonElement | undefined
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  localStorage.clear()
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true, mtimeMs: 456 })
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TextEditor review bar', () => {
  it('shows Keep/Revert after a host content change and Keep removes it', () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: 'const a = 2\n', mtimeMs: 124 })))
      expect(mounted.container.textContent).toContain('File changed')
      expect(mounted.container.querySelector('[data-cursorlike-review-actions]')).not.toBeNull()
      expect(button(mounted.container, 'Keep')).toBeDefined()
      expect(button(mounted.container, 'Revert')).toBeDefined()

      click(button(mounted.container, 'Keep')!)
      expect(button(mounted.container, 'Keep')).toBeUndefined()
      expect(button(mounted.container, 'Undo')).toBeDefined()

      click(button(mounted.container, 'Undo')!)
      expect(mounted.container.textContent).toContain('File changed')
    } finally {
      mounted.unmount()
    }
  })

  it('Revert writes the previous bytes and can be undone', async () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: 'const a = 2\n', mtimeMs: 124 })))
      click(button(mounted.container, 'Revert')!)
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe('const a = 1\n')
      expect(button(mounted.container, 'Revert')).toBeUndefined()
      expect(button(mounted.container, 'Undo')).toBeDefined()

      click(button(mounted.container, 'Undo')!)
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[1]![2]).toBe('const a = 2\n')
      expect(mounted.container.textContent).toContain('File changed')
    } finally {
      mounted.unmount()
    }
  })

  it('restores a pending review after the viewer is remounted', async () => {
    const first = renderRoot(createElement(TextEditor, viewerProps()))
    first.rerender(createElement(TextEditor, viewerProps({ content: 'const a = 2\n', mtimeMs: 124 })))
    expect(button(first.container, 'Keep')).toBeDefined()
    first.unmount()

    const second = renderRoot(createElement(TextEditor, viewerProps({ content: 'const a = 2\n', mtimeMs: 124 })))
    await act(async () => { await Promise.resolve() })
    expect(second.container.querySelector('[data-cursorlike-review-actions]')).not.toBeNull()
    expect(button(second.container, 'Keep')).toBeDefined()
    click(button(second.container, 'Keep')!)
    expect(button(second.container, 'Keep')).toBeUndefined()
    second.unmount()
  })
})
