// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { act } from 'react-dom/test-utils'
import { NativeReviewActions } from '../src/client/native-review-actions.tsx'
import { api } from '../src/client/api.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
const target = 'ONE\ntwo\nTHREE\n'
let disk = target
const actionUrl = '/api/changes.open?sessionId=session&seq=5&index=0'
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
const row = (kind: string, old: string, next: string, text: string) => h('div', { 'data-diff-line': kind }, h('span', null, old), h('span', null, next), h('span', null, kind === 'del' ? '-' : '+'), h('span', null, text))
function view(split = false) {
  const lines = split
    ? h('div', { 'data-review-view': 'split' },
      h('div', { 'data-diff-side': 'left' }, h('div', { 'data-diff-line': 'del' }, h('span', null, '1'), h('span', null, 'one'))),
      h('div', { 'data-diff-side': 'right' }, h('div', { 'data-diff-line': 'add' }, h('span', null, '1'), h('span', null, 'ONE'))))
    : h('div', { 'data-review-view': 'unified' }, row('del', '1', '', 'one'), row('add', '', '1', 'ONE'), row('context', '2', '2', 'two'), row('del', '3', '', 'three'), row('add', '', '3', 'THREE'))
  return h('div', { 'data-changes-review': true }, h('header', null, h(NativeReviewActions, { actionUrl })), lines)
}
beforeEach(() => {
  disk = target
  localStorage.clear()
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    kind: 'text', path: '/p/a.md', before: true, after: true, coarse: false,
    hunks: [{ newStart: 1, lines: ['-one', '+ONE', ' two', '-three', '+THREE'] }],
  }) })))
  vi.spyOn(api, 'fsRead').mockImplementation(async () => ({ kind: 'text', content: disk, size: disk.length, mtimeMs: 7 }))
  vi.spyOn(api, 'fsWrite').mockImplementation(async (_scope, _path, content) => { disk = content; return { ok: true, mtimeMs: 8 } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('official round review line controls', () => {
  it('normalizes a late host split default but leaves an explicit user choice alone', async () => {
    const toggle = vi.fn()
    const fixture = () => h('div', { 'data-changes-review': true }, h('header', null,
      h('button', { 'data-review-tool': 'split', 'aria-pressed': false, onClick: toggle }, 'split'), h(NativeReviewActions, { actionUrl })),
      row('del', '1', '', 'one'), row('add', '', '1', 'ONE'))
    const first = renderRoot(fixture())
    await flush()
    act(() => { first.container.querySelector('[data-review-tool="split"]')!.setAttribute('aria-pressed', 'true') })
    await flush()
    expect(toggle).toHaveBeenCalledTimes(1)
    first.unmount()
    toggle.mockClear()
    const second = renderRoot(fixture())
    await flush()
    const button = second.container.querySelector('[data-review-tool="split"]')!
    act(() => { button.dispatchEvent(new Event('pointerdown', { bubbles: true })); button.setAttribute('aria-pressed', 'true') })
    await flush()
    expect(toggle).not.toHaveBeenCalled()
    second.unmount()
  })
  it('starts a new native review unified without overriding later manual choices', async () => {
    const toggle = vi.fn()
    const fixture = () => h('div', { 'data-changes-review': true }, h('header', null,
      h('button', { 'data-review-tool': 'split', 'aria-pressed': true, onClick: toggle }, 'split'), h(NativeReviewActions, { actionUrl })),
      row('del', '1', '', 'one'), row('add', '', '1', 'ONE'))
    const root = renderRoot(fixture())
    await flush()
    expect(toggle).toHaveBeenCalledTimes(1)
    root.rerender(fixture())
    await flush()
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(root.container.querySelector('header [data-native-current-keep]')).toBeNull()
    expect(root.container.querySelector('[data-cursorlike-review-toolbar] [data-native-current-keep]')).not.toBeNull()
    root.unmount()
  })
  it('accepts every block, preserves keyboard focus and restores comparisons with Ctrl+Z', async () => {
    const root = renderRoot(view())
    await flush()
    root.container.querySelector<HTMLButtonElement>('[data-native-current-keep]')!.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(root.container.querySelectorAll('[data-cursorlike-native-decision="keep"]')).toHaveLength(4)
    expect(root.container.querySelector('[data-native-current-keep]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-keyshortcuts')).toBe('Control+Z')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(root.container.querySelectorAll('[data-cursorlike-native-decision="pending"]')).toHaveLength(4)
    expect(root.container.querySelectorAll('[data-native-line-keep]')).toHaveLength(2)
    expect(api.fsWrite).not.toHaveBeenCalled()
    root.unmount()
  })
  it('treats consecutive rewritten lines as one change and one decision', async () => {
    disk = 'ONE\nTWO\nTHREE\n'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      kind: 'text', path: '/p/a.md', before: true, after: true, coarse: false,
      hunks: [{ newStart: 1, lines: ['-one', '-two', '-three', '+ONE', '+TWO', '+THREE'] }],
    }) })))
    const root = renderRoot(h('div', { 'data-changes-review': true }, h('header', null, h(NativeReviewActions, { actionUrl })),
      row('del', '1', '', 'one'), row('del', '2', '', 'two'), row('del', '3', '', 'three'),
      row('add', '', '1', 'ONE'), row('add', '', '2', 'TWO'), row('add', '', '3', 'THREE')))
    await flush()
    expect(root.container.querySelectorAll('[data-native-line-keep]')).toHaveLength(1)
    expect(root.container.querySelectorAll('[data-native-line-reject]')).toHaveLength(1)
    expect(root.container.querySelector('[role="status"]')?.textContent).toContain('Change 1 of 1')
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-current-reject]')!.click() })
    await flush()
    expect(disk).toBe('one\ntwo\nthree\n')
    root.unmount()
  })
  it('displays the current-action and undo keyboard shortcuts', async () => {
    const root = renderRoot(view())
    await flush()
    expect(root.container.querySelector('[data-native-current-keep]')?.textContent).toContain('Ctrl+K')
    expect(root.container.querySelector('[data-native-current-reject]')?.textContent).toContain('Ctrl+J')
    expect(root.container.querySelector('[aria-keyshortcuts="Control+Z"]')?.textContent).toContain('Ctrl+Z')
    expect(root.container.querySelector('[data-cursorlike-native-layout="unified"]')).not.toBeNull()
    root.unmount()
  })
  it('navigates with the down button and decides only the current change', async () => {
    const root = renderRoot(view())
    await flush()
    act(() => { root.container.querySelector<HTMLButtonElement>('button[aria-label="Next change"]')!.click() })
    expect(root.container.querySelector('[data-cursorlike-native-active="true"]')?.getAttribute('data-cursorlike-native-line')).toBe('1')
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-current-reject]')!.click() })
    await flush()
    expect(disk).toBe('ONE\ntwo\nthree\n')
    expect(root.container.querySelector('[data-native-line-reject="0"]')?.getAttribute('aria-pressed')).toBe('false')
    root.unmount()
  })
  it('handles review shortcuts only inside its own round tab', async () => {
    const root = renderRoot(view())
    await flush()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(api.fsWrite).not.toHaveBeenCalled()
    root.container.querySelector<HTMLButtonElement>('[data-native-line-keep="0"]')!.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(disk).toBe('one\ntwo\nTHREE\n')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(disk).toBe(target)
    outside.remove()
    root.unmount()
  })
  it('shows controls on changed lines, reverts only one line and undoes the decision', async () => {
    const root = renderRoot(view())
    await flush()
    expect(root.container.querySelectorAll('[data-native-line-keep]')).toHaveLength(2)
    expect(root.container.querySelector('[data-diff-line="context"] [data-native-line-keep]')).toBeNull()
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-line-reject="0"]')!.click() })
    await flush()
    expect(disk).toBe('one\ntwo\nTHREE\n')
    expect(api.fsWrite).toHaveBeenCalledWith({ sessionId: 'session' }, '/p/a.md', disk, 7)
    expect(root.container.querySelector('[data-cursorlike-native-active="true"]')?.getAttribute('data-cursorlike-native-line')).toBe('1')
    const undo = root.container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+Z"]')!
    act(() => { undo.click() })
    await flush()
    expect(disk).toBe(target)
    root.unmount()
  })
  it('reopens a rejected block and can undo reopening it', async () => {
    const root = renderRoot(view())
    await flush()
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-line-reject="0"]')!.click() })
    await flush()
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-reopen="0"]')!.click() })
    await flush()
    expect(disk).toBe(target)
    act(() => { root.container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+Z"]')!.click() })
    await flush()
    expect(disk).toBe('one\ntwo\nTHREE\n')
    root.unmount()
  })
  it('retains original comparison and decisions after reopening the round tab', async () => {
    const first = renderRoot(view())
    await flush()
    act(() => { first.container.querySelector<HTMLButtonElement>('[data-native-line-reject="0"]')!.click() })
    await flush()
    first.unmount()
    const second = renderRoot(view())
    await flush()
    expect(second.container.querySelector('[data-cursorlike-native-line="0"]')?.getAttribute('data-cursorlike-native-decision')).toBe('reject')
    expect(second.container.querySelectorAll('[data-native-line-keep]')).toHaveLength(1)
    expect(second.container.querySelector('[data-native-reopen="0"]')).not.toBeNull()
    second.unmount()
  })
  it('reattaches controls when the host switches to split columns, and cleans up on close', async () => {
    const root = renderRoot(view())
    await flush()
    root.rerender(view(true))
    await flush()
    expect(root.container.querySelectorAll('[data-native-line-keep="0"]')).toHaveLength(1)
    root.unmount()
    expect(document.querySelector('[data-cursorlike-native-line-actions]')).toBeNull()
  })
  it('refuses a changed disk revision and leaves the decision pending', async () => {
    const root = renderRoot(view())
    await flush()
    disk = 'user edits\n'
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-line-reject="0"]')!.click() })
    await flush()
    expect(api.fsWrite).not.toHaveBeenCalled()
    expect(root.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(root.container.querySelector('[data-native-line-reject="0"]')?.getAttribute('aria-pressed')).toBe('false')
    root.unmount()
  })
  it('paints an approved block as ordinary content and restores the comparison on undo', async () => {
    const root = renderRoot(view())
    await flush()
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-line-keep="0"]')!.click() })
    await flush()
    const added = root.container.querySelector<HTMLElement>('[data-diff-line="add"][data-cursorlike-native-line="0"]')!
    const deleted = root.container.querySelector<HTMLElement>('[data-diff-line="del"][data-cursorlike-native-line="0"]')!
    // Resolved rows carry inline overrides so the host's red/green paint is gone.
    expect(added.style.getPropertyValue('background-color')).toContain('--dsw-alias-bg-base')
    expect(added.style.getPropertyValue('color')).toBe('var(--dsw-alias-label-primary)')
    expect(deleted.style.display).toBe('none')

    act(() => { root.container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+Z"]')!.click() })
    await flush()
    expect(added.style.getPropertyValue('background-color')).toBe('')
    expect(added.style.getPropertyValue('color')).toBe('')
    expect(deleted.style.display).toBe('')
    expect(root.container.querySelector('[data-cursorlike-native-line="0"]')?.getAttribute('data-cursorlike-native-decision')).toBe('pending')
    root.unmount()
  })
  it('restores the host row inline styles on undo', async () => {
    const root = renderRoot(view())
    await flush()
    const added = root.container.querySelector<HTMLElement>('[data-diff-line="add"][data-cursorlike-native-line="0"]')!
    added.style.backgroundColor = 'rgb(1, 2, 3)'
    added.style.color = 'rgb(4, 5, 6)'
    act(() => { root.container.querySelector<HTMLButtonElement>('[data-native-line-keep="0"]')!.click() })
    await flush()
    expect(added.style.getPropertyValue('background-color')).toBe('var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1))')
    act(() => { root.container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+Z"]')!.click() })
    await flush()
    expect(added.style.getPropertyValue('background-color')).toBe('rgb(1, 2, 3)')
    expect(added.style.getPropertyValue('color')).toBe('rgb(4, 5, 6)')
    root.unmount()
  })
  it('keeps undo available after the official card remounts', async () => {
    const first = renderRoot(view())
    await flush()
    act(() => { first.container.querySelector<HTMLButtonElement>('[data-native-current-keep]')!.focus() })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(first.container.querySelectorAll('[data-cursorlike-native-decision="keep"]')).toHaveLength(4)
    first.unmount()

    const second = renderRoot(view())
    await flush()
    // Decisions and the undo stack both survive the host remount.
    expect(second.container.querySelectorAll('[data-cursorlike-native-decision="keep"]')).toHaveLength(4)
    const undo = second.container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+Z"]')!
    expect(undo.disabled).toBe(false)
    // Focus rests on the body after a remount; Ctrl+Z on the review page still
    // walks the recovered decision back and repaints the comparison.
    expect(document.activeElement).toBe(document.body)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(second.container.querySelectorAll('[data-cursorlike-native-decision="pending"]')).toHaveLength(4)
    second.unmount()
  })
})
