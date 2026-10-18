// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
const insert = vi.hoisted(() => vi.fn(() => true))
vi.mock('../src/client/conversation-draft.ts', () => ({ insertSelectionReference: insert }))
beforeEach(() => {
  localStorage.clear()
  insert.mockClear()
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
})

describe('rendered Markdown selection', () => {
  it.each(['button', 'shortcut'])('inserts the selected preview text using %s', async trigger => {
    const ctx = {} as never
    const view = renderRoot(createElement(TextEditor, {
      ctx, store: createSidebarStore(), scope: { sessionId: 's', cwd: '/p' },
      path: '/p/a.md', title: 'a.md', viewerId: 'markdown', content: '- [x] **任务完成**\n', mtimeMs: 1,
    }))
    try {
      await act(async () => { await Promise.resolve() })
      const text = [...view.container.querySelectorAll('strong')].find(node => node.textContent === '任务完成')!.firstChild!
      const range = document.createRange()
      range.selectNodeContents(text)
      Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, top: 100, width: 60 }) })
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 700, bottom: 500, width: 700, height: 500, x: 0, y: 0, toJSON: () => ({}) })
      act(() => { text.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
      const popup = document.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Control+L"]')!
      expect(popup.textContent).toContain('Ctrl+L')
      expect(popup.style.left).toBe('684px')
      expect(popup.style.top).toBe('484px')
      bounds.mockRestore()
      act(() => {
        if (trigger === 'button') popup.click()
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }))
      })
      expect(insert).toHaveBeenCalledWith(ctx, 's', { path: '/p/a.md', lines: { start: 1, end: 1 }, text: '任务完成' })
    } finally {
      window.getSelection()?.removeAllRanges()
      view.unmount()
      vi.unstubAllGlobals()
    }
  })
})
