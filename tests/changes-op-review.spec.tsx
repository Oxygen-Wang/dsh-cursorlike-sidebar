/**
 * The changes tab's per-hunk review: a session op's full-document basis, and
 * the DiffPane controls that keep/revert blocks (writing the reconstruction
 * back to disk, advancing to the next block).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
import { renderRoot } from './test-utils.ts'
import { createElement } from 'react'
import { DiffPane } from '../src/client/changes/DiffPane.tsx'
import { reviewBasisOf, sameText } from '../src/client/changes/op-review.ts'
import type { FileOp } from '../src/client/changes/ops.ts'

setupReactAct()

const fsRead = vi.fn()
const fsWrite = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: { ...actual.api, fsRead: (...args: unknown[]) => fsRead(...args), fsWrite: (...args: unknown[]) => fsWrite(...args) },
  }
})

const BASE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n'
const TARGET = 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n'

function editOp(overrides: Partial<FileOp> = {}): FileOp {
  return {
    callId: 'c1',
    kind: 'edit',
    path: '/p/a.ts',
    time: 1,
    running: false,
    isError: false,
    edit: { oldString: 'one', newString: 'ONE' },
    ...overrides,
  }
}

function pane(op: FileOp, prior: string | undefined) {
  return createElement(DiffPane, {
    target: { kind: 'op', path: '/p/a.ts', op, prior },
    ctx: {} as never,
    scope: { sessionId: 's1', cwd: '/p' },
    height: 300,
    onHeightCommit: () => {},
    onClose: () => {},
    onExpand: () => {},
  })
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label)) as HTMLButtonElement | undefined
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  localStorage.clear()
  fsRead.mockReset()
  fsWrite.mockReset()
  fsWrite.mockImplementation(async (_scope: unknown, _path: unknown, text: string) => ({ ok: true, mtimeMs: 100 + text.length }))
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('reviewBasisOf', () => {
  it('rebuilds an edit from the prior content', () => {
    expect(reviewBasisOf(editOp(), BASE)).toEqual({ base: BASE, target: BASE.replace('one', 'ONE') })
  })

  it('answers null without prior content, for a fragment, or for a no-op', () => {
    expect(reviewBasisOf(editOp(), undefined)).toBeNull()
    expect(reviewBasisOf(editOp({ edit: { oldString: 'missing', newString: 'x' } }), BASE)).toBeNull()
    expect(reviewBasisOf(editOp({ kind: 'read', edit: undefined }), BASE)).toBeNull()
    expect(reviewBasisOf(editOp({ running: true }), BASE)).toBeNull()
    expect(reviewBasisOf(editOp({ isError: true }), BASE)).toBeNull()
  })

  it('builds a write basis only when the prior content differs', () => {
    const write: FileOp = { callId: 'w', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    expect(reviewBasisOf(write, BASE)).toEqual({ base: BASE, target: TARGET })
    expect(reviewBasisOf(write, TARGET)).toBeNull()
    expect(reviewBasisOf(write, undefined)).toBeNull()
  })

  it('compares documents across line-ending spellings', () => {
    expect(sameText('a\nb', 'a\r\nb')).toBe(true)
    expect(sameText('a\nb', 'a\nc')).toBe(false)
  })
})

describe('DiffPane op review', () => {
  it('finishes a write when a poll rebuilds the same operation object', async () => {
    const op = editOp()
    const content = BASE.replace('one', 'ONE')
    fsRead.mockResolvedValue({ kind: 'text', content, mtimeMs: 7 })
    let finish!: (value: { ok: true; mtimeMs: number }) => void
    fsWrite.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const view = renderRoot(pane(op, BASE))
    await settle()
    act(() => { view.container.querySelector<HTMLButtonElement>('button[data-action="reject"]')!.click() })
    view.rerender(pane({ ...op }, BASE))
    await act(async () => { finish({ ok: true, mtimeMs: 8 }); await Promise.resolve() })
    expect(view.container.textContent).toContain('Reverted')
    expect(fsRead).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('scrolls to the next pending line after keeping the current one', async () => {
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scroll, configurable: true })
    const write: FileOp = { callId: 'jump', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, mtimeMs: 7 })
    const view = renderRoot(pane(write, BASE))
    await settle()
    scroll.mockClear()
    act(() => { view.container.querySelector<HTMLButtonElement>('button[data-action="keep"]')!.click() })
    await settle()
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    const target = scroll.mock.contexts[0] as HTMLElement
    expect(target.dataset.reviewHunk).toBe('1')
    view.unmount()
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
  it('restores line decisions and original comparison after a remount', async () => {
    const content = 'ONE\ncontext\nTWO\nthree\n'
    const base = 'one\ncontext\ntwo\nthree\n'
    const write: FileOp = { callId: 'restart', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content }
    fsRead.mockResolvedValue({ kind: 'text', content, mtimeMs: 7 })
    const first = renderRoot(pane(write, base))
    await settle()
    act(() => { first.container.querySelector<HTMLButtonElement>('button[data-action="reject"]')!.click() })
    await settle()
    expect(fsWrite.mock.calls[0]![2]).toBe('one\ncontext\nTWO\nthree\n')
    first.unmount()
    fsRead.mockResolvedValue({ kind: 'text', content: 'one\ncontext\nTWO\nthree\n', mtimeMs: 8 })
    const second = renderRoot(pane(write, base))
    await settle()
    expect(second.container.querySelectorAll('button[data-action="keep"]')).toHaveLength(2)
    expect(second.container.querySelector('button[data-action="reject"][data-current="true"]')).not.toBeNull()
    expect(second.container.textContent).toContain('1 left')
    second.unmount()
  })

  it('reconstructs an edit without a prior read using the unique live replacement', async () => {
    const content = BASE.replace('one', 'ONE')
    fsRead.mockResolvedValue({ kind: 'text', content, mtimeMs: 7 })
    const view = renderRoot(pane(editOp(), undefined))
    await settle()
    expect(view.container.querySelector('button[data-action="reject"]')).not.toBeNull()
    act(() => { view.container.querySelector<HTMLButtonElement>('button[data-action="reject"]')!.click() })
    await settle()
    expect(fsWrite.mock.calls[0]![2]).toBe(BASE)
    view.unmount()
  })
  it('shows the hunk bar and keeps a block without writing', async () => {
    const op = editOp()
    const edited = BASE.replace('one', 'ONE')
    fsRead.mockResolvedValue({ kind: 'text', content: edited, size: edited.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(op, BASE))
    try {
      await settle()
      const bar = mounted.container.querySelector('[data-changes-op-review]')
      expect(bar).not.toBeNull()
      expect(bar!.textContent).toContain('Change 1 of 1')
      expect(bar!.textContent).toContain('Keep this change')
      expect(bar!.textContent).toContain('Revert this change')

      const keep = button(mounted.container, 'Keep this change')!
      act(() => { keep.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      expect(fsWrite).not.toHaveBeenCalled()
      expect(mounted.container.textContent).toContain('Kept')
      expect(button(mounted.container, 'Undo')).toBeDefined()
    } finally {
      mounted.unmount()
    }
  })

  it('reverts only the active hunk and writes the reconstruction back', async () => {
    // A full-document write with two distant changes -> two hunks.
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      expect(mounted.container.textContent).toContain('Change 1 of 2')
      const revert = button(mounted.container, 'Revert this change')!
      act(() => { revert.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      // Only the first hunk is back to its old text; the second stays.
      expect(fsWrite.mock.calls[0]![2]).toBe(TARGET.replace('ONE', 'one'))
      expect(mounted.container.textContent).toContain('Change 2 of 2')
      expect(mounted.container.textContent).toContain('1 left')
    } finally {
      mounted.unmount()
    }
  })

  it('reverts every remaining hunk in one Ctrl+Alt+J step', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      const rejectAll = button(mounted.container, 'Revert all')!
      rejectAll.focus()
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
      })
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe(BASE)
      expect(mounted.container.textContent).toContain('Reverted')
    } finally {
      mounted.unmount()
    }
  })

  it('keeps the plain diff when the file on disk moved past the op', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: 'something else\n', size: 10, mtimeMs: 9 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      expect(mounted.container.querySelector('[data-changes-op-review]')).toBeNull()
      expect(mounted.container.textContent).toContain('changed on disk')
      expect(button(mounted.container, 'Revert this change')).toBeUndefined()
    } finally {
      mounted.unmount()
    }
  })

  it('offers keep/reject on each changed line and advances to the next one', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      const lineButtons = [...mounted.container.querySelectorAll('button[data-action]')]
      expect(lineButtons.filter(item => item.getAttribute('data-action') === 'keep')).toHaveLength(2)
      expect(lineButtons.filter(item => item.getAttribute('data-action') === 'reject')).toHaveLength(2)

      const firstKeep = lineButtons.find(item => item.getAttribute('data-action') === 'keep')! as HTMLButtonElement
      act(() => { firstKeep.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      // Line 1 is confirmed without writing; the bar advanced to line 2.
      expect(fsWrite).not.toHaveBeenCalled()
      expect(mounted.container.textContent).toContain('Change 2 of 2')
      expect(mounted.container.textContent).toContain('1 left')
    } finally {
      mounted.unmount()
    }
  })

  it('rejects one specific line, then keeps it again when clicked back', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      const rejects = [...mounted.container.querySelectorAll('button[data-action="reject"]')] as HTMLButtonElement[]
      act(() => { rejects[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      // Only line 1 was reverted; the second hunk is still the agent's text.
      expect(fsWrite.mock.calls[0]![2]).toBe(TARGET.replace('ONE', 'one'))

      const keeps = [...mounted.container.querySelectorAll('button[data-action="keep"]')] as HTMLButtonElement[]
      act(() => { keeps[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[1]![2]).toBe(TARGET)
    } finally {
      mounted.unmount()
    }
  })

  it('ignores the review shortcuts while focus is outside the changes tab', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const mounted = renderRoot(pane(write, BASE))
    try {
      await settle()
      // Focus outside the Changes tab (e.g. the composer): the chord belongs
      // to that surface, not to a review the reader is not looking at.
      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
      })
      await settle()
      expect(fsWrite).not.toHaveBeenCalled()
      outside.remove()
    } finally {
      mounted.unmount()
    }
  })

  it('hands the next changed file back to the caller when every line is resolved', async () => {
    const write: FileOp = { callId: 'w1', kind: 'write', path: '/p/a.ts', time: 1, running: false, isError: false, content: TARGET }
    fsRead.mockResolvedValue({ kind: 'text', content: TARGET, size: TARGET.length, mtimeMs: 7 })
    const onReviewComplete = vi.fn()
    const mounted = renderRoot(createElement(DiffPane, {
      target: { kind: 'op', path: '/p/a.ts', op: write, prior: BASE },
      ctx: {} as never,
      scope: { sessionId: 's1', cwd: '/p' },
      height: 300,
      onHeightCommit: () => {},
      onClose: () => {},
      onExpand: () => {},
      onReviewComplete,
    }))
    try {
      await settle()
      expect(onReviewComplete).not.toHaveBeenCalled()
      const rejectAll = button(mounted.container, 'Revert all')!
      act(() => { rejectAll.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await settle()
      expect(onReviewComplete).toHaveBeenCalledWith('w1')
    } finally {
      mounted.unmount()
    }
  })
})
