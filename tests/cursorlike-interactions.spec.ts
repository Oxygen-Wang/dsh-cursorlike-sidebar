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
  it('preserves plain editor selection while attaching the session payload', () => {
    const data = transfer()
    data.setData('text/plain', 'original')
    writeSelectionDrag(data, 'session-1', 'formatted code')
    expect(data.getData('text/plain')).toBe('original')
    expect(readCursorlikeDrag(data)).toEqual({ version: 1, sessionId: 'session-1', paths: [], text: 'formatted code' })
  })
  it.each(['null', '{}', '{bad', '{"version":1,"sessionId":"s","paths":[null]}'])('rejects malformed payload %s', raw => {
    const data = transfer()
    data.setData(CURSORLIKE_DRAG, raw)
    expect(readCursorlikeDrag(data)).toBeUndefined()
  })
})
