/**
 * End-to-end pending-edit review: a model write reaches the REAL TextEditor
 * through the real EditorHost. The host must refresh the bytes WITHOUT
 * remounting the viewer, so the editor can diff them against what it showed,
 * render the inline Keep/Revert row, and revert/undo by writing the file.
 *
 * This is the regression the component-level spec cannot see: the host used to
 * publish `{ status: 'loading' }` for every model write, which rebuilt the
 * viewer and made "the content changed while mounted" detection impossible.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

setupReactAct()

const fsRead = vi.fn()
const fsWrite = vi.fn()
const changesOps = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsRead: (...args: unknown[]) => fsRead(...args),
      fsWrite: (...args: unknown[]) => fsWrite(...args),
      changesOps: (...args: unknown[]) => changesOps(...args),
      mediaUrl: () => '',
    },
  }
})

function writePair(seq: number, path: string, callId = `w${seq}`): SidebarSessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { name: 'write', callId, arguments: JSON.stringify({ file_path: path, content: 'model body' }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
    },
  ]
}

function delta(events: SidebarSessionEvent[], lastSeq: number): { events: SidebarSessionEvent[]; lastSeq: number } {
  return { events, lastSeq }
}

interface Harness {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  tab: SidebarTab
}

function harness(sessionId: string, path: string): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'code',
    exts: ['ts'],
    priority: -100,
    fetchStrategy: 'fsRead',
    component: (props: FileViewerProps) => createElement(TextEditor, props),
  })
  store.setSession(sessionId)
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/tmp' } } }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path, id: `editor:${path}` })
  const tab = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs).find(item => item.path === path)!
  return { ctx, store, tab }
}

function editorElement(harnessed: Harness, sessionId: string): ReturnType<typeof createElement> {
  return createElement(EditorHost, {
    ctx: harnessed.ctx,
    store: harnessed.store,
    scope: { sessionId, cwd: '/tmp' },
    tab: harnessed.tab,
    visible: true,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  })
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function tick(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
  await settle()
}

function docText(container: HTMLElement): string {
  const content = container.querySelector('.cm-content')
  if (content === null) return ''
  // The inline action row is a widget INSIDE the content element: reading the
  // document must not pick its button labels up.
  const clone = content.cloneNode(true) as HTMLElement
  for (const actions of clone.querySelectorAll('[data-cursorlike-review-actions]')) actions.remove()
  return clone.textContent ?? ''
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label)) as HTMLButtonElement | undefined
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

let contentVersion = 0

beforeEach(() => {
  vi.useFakeTimers()
  contentVersion = 0
  fsRead.mockReset()
  fsRead.mockImplementation(async () => ({ kind: 'text', content: `body-${++contentVersion}`, size: 1, mtimeMs: 100 + contentVersion }))
  fsWrite.mockReset()
  fsWrite.mockImplementation(async (_scope: unknown, _path: unknown, text: string) => ({ ok: true, mtimeMs: 500 + text.length }))
  changesOps.mockReset()
  changesOps.mockResolvedValue(delta([], 0))
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

describe('EditorHost + TextEditor pending edit review', () => {
  it('a model write refreshes in place, shows the bar, and Revert writes the old bytes', async () => {
    const harnessed = harness('review-e2e', '/tmp/a.ts')
    const view = renderRoot(editorElement(harnessed, 'review-e2e'))
    try {
      await settle()
      expect(docText(view.container)).toBe('body-1')
      expect(view.container.querySelector('[data-cursorlike-review-actions]')).toBeNull()
      const cm = view.container.querySelector('.cm-editor')

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick()

      // The viewer was NOT remounted: same CodeMirror node, new document.
      expect(view.container.querySelector('.cm-editor')).toBe(cm)
      expect(docText(view.container)).toBe('body-2')
      const actions = view.container.querySelector('[data-cursorlike-review-actions]')
      expect(actions).not.toBeNull()
      expect(actions!.textContent).toContain('File changed')
      expect(actions!.textContent).toContain('Keep')
      expect(actions!.textContent).toContain('Revert')

      click(button(view.container, 'Revert')!)
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe('body-1')
      expect(docText(view.container)).toBe('body-1')
      expect(button(view.container, 'Keep')).toBeUndefined()
      expect(button(view.container, 'Undo')).toBeDefined()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('Keep drops the bar; the NEXT model write is diffed against the kept bytes', async () => {
    const harnessed = harness('review-e2e-keep', '/tmp/a.ts')
    const view = renderRoot(editorElement(harnessed, 'review-e2e-keep'))
    try {
      await settle()
      expect(docText(view.container)).toBe('body-1')

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick()
      expect(docText(view.container)).toBe('body-2')
      click(button(view.container, 'Keep')!)
      expect(button(view.container, 'Keep')).toBeUndefined()
      expect(button(view.container, 'Undo')).toBeDefined()

      changesOps.mockResolvedValue(delta(writePair(21, '/tmp/a.ts'), 22))
      await tick()
      expect(docText(view.container)).toBe('body-3')
      expect(button(view.container, 'Keep')).toBeDefined()

      click(button(view.container, 'Revert')!)
      await settle()
      // Reverting the SECOND edit must restore the KEPT bytes, never the
      // pre-first-edit revision.
      expect(fsWrite.mock.calls[0]![2]).toBe('body-2')
      expect(docText(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})
