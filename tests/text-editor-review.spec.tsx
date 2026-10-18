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

/** Focus one bar control and press a chord: the review keys only act while
 *  the editor or a review bar owns focus. */
function key(element: HTMLElement, init: KeyboardEventInit): void {
  element.focus()
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
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
  it('shows the per-hunk Keep/Revert bar after a host content change and Keep removes it', () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: 'const a = 2\n', mtimeMs: 124 })))
      expect(mounted.container.textContent).toContain('Change 1 of 1')
      expect(mounted.container.querySelector('[data-cursorlike-review-actions]')).not.toBeNull()
      expect(button(mounted.container, 'Keep')).toBeDefined()
      expect(button(mounted.container, 'Revert')).toBeDefined()

      click(button(mounted.container, 'Keep')!)
      expect(button(mounted.container, 'Keep')).toBeUndefined()
      expect(button(mounted.container, 'Undo')).toBeDefined()

      click(button(mounted.container, 'Undo')!)
      expect(mounted.container.textContent).toContain('Change 1 of 1')
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
      expect(mounted.container.textContent).toContain('Change 1 of 1')
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

  it('tints the kept line green and shows the removed line in a red block', async () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: 'const a = 1\nconst b = 2\n' })))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: 'const a = 9\nconst b = 2\n', mtimeMs: 124 })))
      await act(async () => { await Promise.resolve() })
      const removed = mounted.container.querySelector('[data-cursorlike-review-removed]')
      expect(removed).not.toBeNull()
      expect(removed!.textContent).toContain('const a = 1')
      const tinted = [...mounted.container.querySelectorAll('.cm-line')]
        .some(line => line.className.includes('editorReviewLineAdd'))
      expect(tinted).toBe(true)
    } finally {
      mounted.unmount()
    }
  })

  it('gives a pure-deletion hunk its own block and bar', async () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: 'a\nb\nc\n' })))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: 'a\nc\n', mtimeMs: 124 })))
      await act(async () => { await Promise.resolve() })
      expect(mounted.container.querySelector('[data-cursorlike-review-actions]')).not.toBeNull()
      expect(mounted.container.querySelector('[data-cursorlike-review-removed]')?.textContent).toContain('b')
      expect(mounted.container.textContent).toContain('Change 1 of 1')

      click(button(mounted.container, 'Revert')!)
      await act(async () => { await Promise.resolve() })
      expect(fsWrite.mock.calls[0]![2]).toBe('a\nb\nc\n')
      expect(mounted.container.querySelector('[data-cursorlike-review-removed]')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('splits a change into hunks and advances to the next one on Keep', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n'
    const target = 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n'
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: base })))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: target, mtimeMs: 124 })))
      expect(mounted.container.textContent).toContain('Change 1 of 2')
      expect(mounted.container.textContent).toContain('2 left')

      click(button(mounted.container, 'Keep')!)
      expect(mounted.container.textContent).toContain('Change 2 of 2')
      expect(mounted.container.textContent).toContain('1 left')
      expect(fsWrite).not.toHaveBeenCalled()

      click(button(mounted.container, 'Keep')!)
      expect(button(mounted.container, 'Keep')).toBeUndefined()
      expect(button(mounted.container, 'Undo')).toBeDefined()
      expect(fsWrite).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
    }
  })

  it('Ctrl+J rejects only the current hunk and advances', async () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n'
    const target = 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n'
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: base })))
    try {
      mounted.rerender(createElement(TextEditor, viewerProps({ content: target, mtimeMs: 124 })))
      key(button(mounted.container, 'Keep')!, { key: 'j', ctrlKey: true })
      await act(async () => { await Promise.resolve() })
      // Only the first hunk is reverted: the second one stays pending.
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe(target.replace('ONE', 'one'))
      expect(mounted.container.textContent).toContain('Change 2 of 2')
    } finally {
      mounted.unmount()
    }
  })

  it('Ctrl+Alt+K keeps every hunk; Ctrl+Alt+J reverts every hunk', async () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n'
    const target = 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n'

    const kept = renderRoot(createElement(TextEditor, viewerProps({ content: base })))
    kept.rerender(createElement(TextEditor, viewerProps({ content: target, mtimeMs: 124 })))
    key(button(kept.container, 'Keep')!, { key: 'k', ctrlKey: true, altKey: true })
    await act(async () => { await Promise.resolve() })
    expect(kept.container.querySelector('[data-cursorlike-review-actions]')).toBeNull()
    expect(fsWrite).not.toHaveBeenCalled()
    kept.unmount()

    const reverted = renderRoot(createElement(TextEditor, viewerProps({ content: base })))
    reverted.rerender(createElement(TextEditor, viewerProps({ content: target, mtimeMs: 124 })))
    key(button(reverted.container, 'Keep')!, { key: 'j', ctrlKey: true, altKey: true })
    await act(async () => { await Promise.resolve() })
    expect(fsWrite).toHaveBeenCalledTimes(1)
    expect(fsWrite.mock.calls[0]![2]).toBe(base)
    expect(reverted.container.querySelector('[data-cursorlike-review-actions]')).toBeNull()
    reverted.unmount()
  })
})
