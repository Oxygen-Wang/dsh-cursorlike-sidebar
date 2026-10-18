/**
 * The per-hunk review model: split a change into decisions, reconstruct the
 * document after any mix of keeps/rejects, and walk decisions back.
 */
import { describe, expect, it } from 'vitest'
import {
  activeHunkOf,
  buildPendingReview,
  hunkPositions,
  keepAllReviewHunks,
  keepReviewHunk,
  nextPending,
  previousPending,
  readStoredPendingReview,
  rejectAllPendingHunks,
  rejectReviewHunk,
  reviewSummary,
  reviewText,
  storePendingReview,
  undoReviewStep,
  walkReview,
} from '../src/client/diff/review-model.ts'

/** Two separate change blocks: a rewrite near the top, an insertion near the
 *  bottom, far enough apart to stay distinct hunks. */
const BASE = [
  'function alpha() {',
  '  return 1',
  '}',
  '',
  'function beta() {',
  '  return 2',
  '}',
  '',
  'function gamma() {',
  '  return 3',
  '}',
  '',
].join('\n')

const TARGET = [
  'function alpha() {',
  '  return 100',
  '}',
  '',
  'function beta() {',
  '  return 2',
  '}',
  '',
  'function gamma() {',
  '  const label = "gamma"',
  '  return 3',
  '}',
  '',
].join('\n')

/** Reject every hunk at once and answer the resulting text. */
function rejectedText(base: string, target: string): string {
  return rejectAllPendingHunks(buildPendingReview(base, target, '/p/a.ts')).text ?? ''
}

describe('buildPendingReview', () => {
  it('splits a change into one hunk per changed run', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    expect(review.hunks).toHaveLength(2)
    // The first block is a rewrite: its replaced line lives on the hunk's mod
    // row, so `oldLines` (plain deletions) stays empty.
    expect(review.hunks[0]!.oldLines).toEqual([])
    expect(review.hunks[0]!.rewritten).toBe(1)
    expect(review.hunks[0]!.newLines).toEqual(['  return 100'])
    expect(review.hunks[1]!.oldLines).toEqual([])
    expect(review.hunks[1]!.newLines).toEqual(['  const label = "gamma"'])
    expect(review.active).toBe(0)
    expect(review.decided).toBe(false)
    expect(reviewText(review)).toBe(TARGET)
  })

  it('returns an empty, already-decided review for a no-op change', () => {
    const review = buildPendingReview(BASE, BASE, '/p/a.ts')
    expect(review.hunks).toEqual([])
    expect(review.decided).toBe(true)
    expect(reviewText(review)).toBe(BASE)
  })

  it('models a whole-file replacement as one hunk of old and new lines', () => {
    const review = buildPendingReview('a\nb\n', 'c\n', '/p/a.ts')
    expect(review.hunks).toHaveLength(1)
    const hunk = review.hunks[0]!
    expect(hunk.oldLines).toEqual(['b'])
    expect(hunk.rewritten).toBe(1)
    expect(hunk.newLines).toEqual(['c'])
    expect(reviewText(review)).toBe('c\n')
  })

  it('places hunks at their target lines and reports their emitted lines', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    const positions = hunkPositions(review)
    // The rewrite sits after the first function's opening line.
    expect(positions.get(0)).toEqual({ anchor: 1, lines: 1 })
    // The insertion sits after `function gamma() {` (target line 9).
    expect(positions.get(1)).toEqual({ anchor: 9, lines: 1 })
  })
})

describe('reviewText / rejection', () => {
  it('splits each changed line into its own decision when asked', () => {
    const review = buildPendingReview('a\nb\nc\n', 'a\nB\nC\n', '/p/a.ts', { splitLines: true })
    expect(review.hunks).toHaveLength(2)
    expect(reviewText(review)).toBe('a\nB\nC\n')
    const step = rejectReviewHunk(review, review.hunks[0]!.id)
    expect(step.text).toBe('a\nb\nC\n')
    expect(step.review.hunks[1]!.decision).toBe('pending')
    const undone = undoReviewStep(step.review, step.undo)
    expect(undone.text).toBe('a\nB\nC\n')
  })

  it('keeps a deleted line removable and restorable on its own', () => {
    const review = buildPendingReview('a\nb\nc\n', 'a\nc\n', '/p/a.ts', { splitLines: true })
    expect(review.hunks).toHaveLength(1)
    const rejected = rejectReviewHunk(review, review.hunks[0]!.id)
    expect(rejected.text).toBe('a\nb\nc\n')
    const kept = keepReviewHunk(rejected.review, review.hunks[0]!.id)
    expect(reviewText(kept.review)).toBe('a\nc\n')
  })

  it('rebuilds the base when every hunk is rejected', () => {
    const step = rejectAllPendingHunks(buildPendingReview(BASE, TARGET, '/p/a.ts'))
    expect(step.text).toBe(BASE)
    expect(step.review.decided).toBe(true)
    expect(reviewSummary(step.review)).toEqual({ total: 2, pending: 0, kept: 0, rejected: 2 })
    expect(walkReview(step.review).placements.get(0)).toEqual({ anchor: 1, lines: 0 })
  })

  it.each([
    ['a\nb\nc\n', 'a\nc\n'],
    ['a\nb\nc\n', 'a\nc\nb\nc\n'],
    ['a\nb\n', 'c\n'],
    ['x\na\nb\n', 'x\na\n'],
    ['a\nb\nc\n', 'a\nc\nc\n'],
    ['a\nb\nc\nd\ne\n', 'a\ne\n'],
    ['a\nb\nc\n', 'a\nx\nb\nc\n'],
    ['x\n', ''],
    ['', 'x\n'],
  ])('restores %j exactly when every hunk of %j is rejected', (base, target) => {
    expect(rejectedText(base, target)).toBe(base)
  })

  it('rejects one hunk at a time and keeps the rest', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    const first = rejectReviewHunk(review, 0)
    expect(first.text).toBe(TARGET.replace('  return 100', '  return 1'))
    expect(first.review.active).toBe(1)
    const second = rejectReviewHunk(first.review, 1)
    expect(second.text).toBe(BASE)
    expect(second.review.decided).toBe(true)
    expect(second.review.active).toBeNull()
  })

  it('is a no-op on a hunk that is already rejected', () => {
    const first = rejectReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts'), 0)
    const again = rejectReviewHunk(first.review, 0)
    expect(again.text).toBeNull()
    expect(again.review).toBe(first.review)
  })
})

describe('keep + navigation', () => {
  it('keeps a hunk without touching the text and advances the bar', () => {
    const step = keepReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts'), 0)
    expect(step.text).toBeNull()
    expect(step.review.hunks[0]!.decision).toBe('keep')
    expect(step.review.active).toBe(1)
    expect(reviewText(step.review)).toBe(TARGET)
  })

  it('wraps around for next/previous pending hunks', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    expect(nextPending(0, review.hunks)).toBe(1)
    expect(nextPending(1, review.hunks)).toBe(0)
    expect(previousPending(0, review.hunks)).toBe(1)
    const firstKept = review.hunks.map((hunk, i) => (i === 0 ? { ...hunk, decision: 'keep' as const } : hunk))
    expect(activeHunkOf({ ...review, active: 0, hunks: firstKept })).toBe(1)
  })

  it('keeps every hunk in one step', () => {
    const step = keepAllReviewHunks(buildPendingReview(BASE, TARGET, '/p/a.ts'))
    expect(step.review.decided).toBe(true)
    expect(step.review.hunks.every(hunk => hunk.decision === 'keep')).toBe(true)
    expect(step.text).toBeNull()
    expect(reviewText(step.review)).toBe(TARGET)
  })
})

describe('undo', () => {
  it('undoes a keep by asking again', () => {
    const step = keepReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts'), 0)
    const undone = undoReviewStep(step.review, step.undo)
    expect(undone.review.hunks[0]!.decision).toBe('pending')
    expect(undone.review.active).toBe(0)
    expect(undone.text).toBeNull()
  })

  it('undoes a reject by restoring the new text', () => {
    const step = rejectReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts'), 1)
    expect(step.text).toBe(TARGET.replace('  const label = "gamma"\n', ''))
    const undone = undoReviewStep(step.review, step.undo)
    expect(undone.text).toBe(TARGET)
    expect(undone.review.hunks[1]!.decision).toBe('pending')
  })

  it('undoes a bulk reject as one step', () => {
    const step = rejectAllPendingHunks(buildPendingReview(BASE, TARGET, '/p/a.ts'))
    expect(step.text).toBe(BASE)
    const undone = undoReviewStep(step.review, step.undo)
    expect(undone.text).toBe(TARGET)
    expect(undone.review.hunks.every(hunk => hunk.decision === 'pending')).toBe(true)
    expect(undone.review.decided).toBe(false)
  })

  it('restores a dismissed review from its snapshot', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    const keepAll = keepAllReviewHunks(review)
    const undone = undoReviewStep(keepAll.review, keepAll.undo)
    expect(undone.text).toBe(TARGET)
    expect(undone.review.hunks).toHaveLength(2)
    expect(undone.review.hunks.every(hunk => hunk.decision === 'pending')).toBe(true)
  })
})

describe('persistence', () => {
  it('round-trips decisions through the stored shape', () => {
    const review = rejectReviewHunk(buildPendingReview(BASE, TARGET, '/p/a.ts'), 0).review
    const restored = readStoredPendingReview(JSON.parse(JSON.stringify(storePendingReview(review))), '/p/a.ts')
    expect(restored).not.toBeNull()
    expect(restored!.hunks.map(hunk => hunk.decision)).toEqual(['reject', 'pending'])
    expect(reviewText(restored!)).toBe(reviewText(review))
  })

  it('rejects a stored review for a different path or shape', () => {
    const review = buildPendingReview(BASE, TARGET, '/p/a.ts')
    const stored = storePendingReview(review)
    expect(readStoredPendingReview(stored, '/p/b.ts')).toBeNull()
    expect(readStoredPendingReview({ ...stored, version: 1 }, '/p/a.ts')).toBeNull()
    expect(readStoredPendingReview({ ...stored, decisions: [{ id: 'x', decision: 'keep' }] }, '/p/a.ts')).toBeNull()
  })
})
