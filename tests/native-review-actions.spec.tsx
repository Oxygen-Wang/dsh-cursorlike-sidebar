// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { reverseReviewText } from '../src/client/native-review-actions.tsx'

describe('official turn review reversal', () => {
  it('restores multiple ranges and preserves unrelated text and CRLF', () => {
    expect(reverseReviewText('other\r\nnew\r\ncontext\r\nadded\r\n', [
      { newStart: 2, lines: ['-old', '+new'] },
      { newStart: 4, lines: ['+added'] },
    ])).toBe('other\r\nold\r\ncontext\r\n')
  })
  it('restores deleted lines at the zero-line insertion coordinate', () => {
    expect(reverseReviewText('a\nb\n', [{ newStart: 1, lines: ['-deleted'] }])).toBe('a\ndeleted\nb\n')
  })
  it('refuses to overwrite a subsequent edit', () => {
    expect(() => reverseReviewText('later\n', [{ newStart: 1, lines: ['-old', '+new'] }])).toThrow('后续修改')
  })
  it('reverses hunks handed over in any order', () => {
    // Descending input: the second change must still land on line 4, not be
    // shifted by the splice performed for line 2.
    expect(reverseReviewText('other\nnew\ncontext\nadded\n', [
      { newStart: 4, lines: ['+added'] },
      { newStart: 2, lines: ['-old', '+new'] },
    ])).toBe('other\nold\ncontext\n')
  })
  it('ignores the no-newline metadata marker', () => {
    expect(reverseReviewText('new\n', [
      { newStart: 1, lines: ['-old', '+new', '\\ No newline at end of file'] },
    ])).toBe('old\n')
  })
  it('rejects malformed hunk data instead of splicing it', () => {
    expect(() => reverseReviewText('new\n', [{ newStart: 1, lines: ['old', '+new'] }])).toThrow('改动数据不可用')
    expect(() => reverseReviewText('new\n', [{ newStart: Number.NaN, lines: ['+new'] }])).toThrow('改动数据不可用')
  })
})
