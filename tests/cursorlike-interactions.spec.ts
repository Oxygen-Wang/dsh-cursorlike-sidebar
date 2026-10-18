// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CURSORLIKE_DRAG, readCursorlikeDrag, writeSelectionDrag } from '../src/client/cursorlike-interactions.ts'

function transfer(): DataTransfer {
  const values = new Map<string, string>()
  return { setData: (key: string, value: string) => { values.set(key, value) },
    getData: (key: string) => values.get(key) ?? '', get types() { return [...values.keys()] },
    effectAllowed: 'all', dropEffect: 'none' } as unknown as DataTransfer
}

describe('CursorLike context drag', () => {
  it('carries the file and line span while preserving a plain-text fallback', () => {
    const data = transfer()
    writeSelectionDrag(data, 'session-1', { path: 'C:/w/a.ts', lines: { start: 12, end: 18 } })
    expect(data.getData('text/plain')).toBe('@C:/w/a.ts line 12-18')
    expect(readCursorlikeDrag(data)).toEqual({
      version: 1,
      sessionId: 'session-1',
      paths: [{ path: 'C:/w/a.ts', directory: false }],
      lineStart: 12,
      lineEnd: 18,
    })
  })
  it.each(['null', '{}', '{bad', '{"version":1,"sessionId":"s","paths":[null]}'])('rejects malformed payload %s', raw => {
    const data = transfer()
    data.setData(CURSORLIKE_DRAG, raw)
    expect(readCursorlikeDrag(data)).toBeUndefined()
  })
})
