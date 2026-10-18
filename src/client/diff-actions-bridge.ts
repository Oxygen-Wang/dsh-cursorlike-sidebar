/**
 * Diff-panel action bridge.
 *
 * `dsh-diff-approval` owns the side-by-side diff but its whole-file Keep /
 * Revert buttons are not always reachable from a docked panel (and have no
 * Ctrl+K / Ctrl+J bindings). This module watches for its panel, appends a
 * small sticky footer with the same two actions, and binds the keyboard
 * shortcuts. The footer only forwards clicks to the other plugin's own
 * `data-diff-*` buttons, so the review data and confirmation flow stay owned by
 * that plugin.
 */
import { t } from './locales.ts'

const ACTION_BAR_ATTR = 'data-cursorlike-diff-actions'
const PANEL_SELECTOR = '[data-diff-approval-dock], [data-diff-approval-panel]'
const KEEP_SELECTOR = '[data-diff-keep]:not([disabled]), [data-diff-block-keep]:not([disabled]), [data-diff-selection-keep]:not([disabled])'
const REVERT_SELECTOR = '[data-diff-revert]:not([disabled]), [data-diff-block-revert]:not([disabled]), [data-diff-selection-revert]:not([disabled])'

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PANEL_SELECTOR)
}

function nativeButton(kind: 'keep' | 'revert'): HTMLButtonElement | null {
  const root = panel() ?? document
  return root.querySelector<HTMLButtonElement>(kind === 'keep' ? KEEP_SELECTOR : REVERT_SELECTOR)
}

function makeButton(kind: 'keep' | 'revert'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.cursorlikeDiffAction = kind
  button.textContent = kind === 'keep' ? `${t('reviewKeep')} Ctrl+K` : `${t('reviewReject')} Ctrl+J`
  const color = kind === 'keep' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-danger)'
  button.style.cssText = `font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 5px; border: 1px solid ${color}; color: ${color}; background: transparent; cursor: pointer; white-space: nowrap;`
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    nativeButton(kind)?.click()
  })
  return button
}

function ensureBar(): void {
  const host = panel()
  if (host === null) return
  const existing = host.querySelector<HTMLElement>(`[${ACTION_BAR_ATTR}]`)
  if (nativeButton('keep') === null && nativeButton('revert') === null) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  const bar = document.createElement('div')
  bar.setAttribute(ACTION_BAR_ATTR, '')
  bar.style.cssText = 'display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent); position: sticky; bottom: 0; z-index: 6;'
  bar.append(makeButton('keep'), makeButton('revert'))
  host.append(bar)
}

/**
 * Install the observer and shortcuts once. Returns a disposer for tests/HMR.
 * @returns teardown function.
 */
export function installDiffActionsBridge(): () => void {
  ensureBar()
  let frame = 0
  const schedule = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      ensureBar()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.altKey) return
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key !== 'k' && key !== 'j') return
    const active = document.activeElement
    if (!(active instanceof Element)) return
    if (active.closest(`${PANEL_SELECTOR}, [${ACTION_BAR_ATTR}]`) === null) return
    const kind = key === 'k' ? 'keep' : 'revert'
    const button = document.querySelector<HTMLButtonElement>(`[${ACTION_BAR_ATTR}] [data-cursorlike-diff-action="${kind}"]`)
    if (button === null) return
    event.preventDefault()
    event.stopPropagation()
    button.click()
  }
  document.addEventListener('keydown', onKey, true)
  return () => {
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    document.removeEventListener('keydown', onKey, true)
    document.querySelector(`[${ACTION_BAR_ATTR}]`)?.remove()
  }
}
