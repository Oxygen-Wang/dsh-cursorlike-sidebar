// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lineSuffix, referenceText } from '../src/client/selection-reference.ts'

describe('selection reference formatting', () => {
  it('formats single lines, ranges and missing line info', () => {
    expect(lineSuffix({ start: 12, end: 12 })).toBe(' line 12')
    expect(lineSuffix({ start: 12, end: 18 })).toBe(' line 12-18')
    expect(lineSuffix()).toBe('')
  })

  it('clamps inverted/zero spans instead of printing a broken range', () => {
    expect(lineSuffix({ start: 0, end: 0 })).toBe(' line 1')
    expect(lineSuffix({ start: 8, end: 3 })).toBe(' line 8')
  })

  it('builds the absolute-path fallback used when no workspace root resolves', () => {
    expect(referenceText({ path: 'C:/w/a.ts', lines: { start: 3, end: 5 } })).toBe('@C:/w/a.ts line 3-5')
    expect(referenceText({ path: 'C:/w/a.ts' })).toBe('@C:/w/a.ts')
  })
})
