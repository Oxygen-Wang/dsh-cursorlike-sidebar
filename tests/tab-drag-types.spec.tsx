// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { TAB_DRAG_TYPE } from '../src/client/TabBar.tsx'
import { Workbench } from '../src/client/split-pane.tsx'
import { makeDefaultState } from '../src/client/state.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
function drag(element: HTMLElement, type: string, eventType = 'dragover'): Event {
  const event = new Event(eventType, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: {
    types: [type], getData: () => JSON.stringify({ tabId: 'a', paneId: 'source' }),
  } })
  act(() => { element.dispatchEvent(event) })
  return event
}
describe('tab drag boundaries', () => {
  it.each(['Files', 'text/plain', 'application/x-cursorlike-context', TAB_DRAG_TYPE])('only claims tab payloads: %s', type => {
    const state = makeDefaultState()
    const moveTabToEdge = vi.fn()
    const moveTabBefore = vi.fn()
    const view = renderRoot(createElement(Workbench, {
      state,
      tree: { kind: 'leaf', id: 'target', tabs: [{ id: 'b', title: 'b.ts', type: 'editor' }], active: 'b' },
      newTabOptions: [], onNewTab: () => {}, renderTab: () => null,
      actions: { closeTab: vi.fn(), activateTab: vi.fn(), focusPane: vi.fn(), moveTabToEdge, moveTabBefore, resizeSplit: vi.fn() },
    }))
    const pane = view.container.querySelector<HTMLElement>('[data-dsh-pane]')!
    const bar = view.container.querySelector<HTMLElement>('[class*="tabBar"]')!
    expect(drag(pane, type).defaultPrevented).toBe(type === TAB_DRAG_TYPE)
    expect(drag(bar, type).defaultPrevented).toBe(type === TAB_DRAG_TYPE)
    drag(bar, type, 'drop')
    expect(moveTabToEdge).toHaveBeenCalledTimes(type === TAB_DRAG_TYPE ? 1 : 0)
    if (type === TAB_DRAG_TYPE) expect(moveTabToEdge).toHaveBeenCalledWith({ tabId: 'a', paneId: 'source' }, 'target', 'center')
    expect(moveTabBefore).not.toHaveBeenCalled()
    view.unmount()
  })
})
