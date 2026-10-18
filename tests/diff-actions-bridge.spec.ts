/**
 * The diff-panel bridge adds a visible Keep/Revert footer to the other
 * plugin's docked panel and forwards Ctrl+K / Ctrl+J to its own data-diff-*
 * buttons.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDiffActionsBridge } from '../src/client/diff-actions-bridge.ts'

let dispose: (() => void) | null = null

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  dispose?.()
  dispose = null
})

function panelWithActions(keep = vi.fn(), revert = vi.fn()): { panel: HTMLElement; keep: HTMLElement; revert: HTMLElement } {
  const panel = document.createElement('div')
  panel.setAttribute('data-diff-approval-dock', '')
  const keepButton = document.createElement('button')
  keepButton.setAttribute('data-diff-keep', '')
  keepButton.addEventListener('click', keep)
  const revertButton = document.createElement('button')
  revertButton.setAttribute('data-diff-revert', '')
  revertButton.addEventListener('click', revert)
  panel.append(keepButton, revertButton)
  document.body.append(panel)
  return { panel, keep: keepButton, revert: revertButton }
}

describe('diff actions bridge', () => {
  it('appends a footer and forwards the keyboard shortcuts', async () => {
    const keep = vi.fn()
    const revert = vi.fn()
    const { panel } = panelWithActions(keep, revert)
    dispose = installDiffActionsBridge()
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })

    const bar = panel.querySelector('[data-cursorlike-diff-actions]')
    expect(bar).not.toBeNull()
    expect(bar?.textContent).toContain('Keep')
    expect(bar?.textContent).toContain('Revert')

    panel.setAttribute('tabindex', '0')
    panel.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }))
    expect(keep).toHaveBeenCalledTimes(1)
    expect(revert).toHaveBeenCalledTimes(1)
  })

  it('uses the native whole-file actions rather than inventing state', () => {
    const keep = vi.fn()
    const { panel } = panelWithActions(keep)
    dispose = installDiffActionsBridge()
    const barButton = panel.querySelector<HTMLButtonElement>('[data-cursorlike-diff-action="keep"]')
    expect(barButton).not.toBeNull()
    barButton?.click()
    expect(keep).toHaveBeenCalledTimes(1)
  })
})
