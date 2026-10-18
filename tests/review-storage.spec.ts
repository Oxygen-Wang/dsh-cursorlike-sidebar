/**
 * Persistence of a changes-tab review: decisions survive a reload only while
 * the file still holds their reconstruction.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { buildPendingReview, rejectReviewHunk, reviewText } from '../src/client/diff/review-model.ts'
import { clearDiffReview, loadDiffReview, saveDiffReview } from '../src/client/diff/review-storage.ts'

const BASE = 'one\ntwo\nthree\n'
const TARGET = 'ONE\ntwo\nTHREE\n'

beforeEach(() => {
  localStorage.clear()
})

describe('diff review storage', () => {
  it('round-trips line-level decisions while the disk still matches', () => {
    const review = rejectReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts', { splitLines: true }), 0).review
    const disk = reviewText(review)
    saveDiffReview('s1', 'id1', review)
    const loaded = loadDiffReview('s1', 'id1', '/p/a.ts', disk)
    expect(loaded).not.toBeNull()
    expect(loaded!.splitLines).toBe(true)
    expect(loaded!.hunks.map(hunk => hunk.decision)).toEqual(['reject', 'pending'])
    expect(reviewText(loaded!)).toBe(disk)
  })

  it('drops a saved review once the file no longer matches', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    saveDiffReview('s1', 'id1', review)
    expect(loadDiffReview('s1', 'id1', '/p/a.ts', 'something else\n')).toBeNull()
  })

  it('matches a CRLF disk spelling of the same document', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    saveDiffReview('s1', 'id1', review)
    const crlfDisk = reviewText(review).replace(/\n/g, '\r\n')
    expect(loadDiffReview('s1', 'id1', '/p/a.ts', crlfDisk)).not.toBeNull()
  })

  it('can forget an entry explicitly', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    saveDiffReview('s1', 'id1', review)
    clearDiffReview('s1', 'id1')
    expect(loadDiffReview('s1', 'id1', '/p/a.ts', TARGET)).toBeNull()
  })

  it('skips documents too large for the storage quota', () => {
    const big = 'x'.repeat(400_001)
    const review = buildPendingReview(big, `${big}y`, '/p/a.ts')
    saveDiffReview('s1', 'id1', review)
    expect(localStorage.length).toBe(0)
  })
})
