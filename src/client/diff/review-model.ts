/**
 * The per-hunk review model behind the editor's inline "agent changed this
 * file" surface (the Cursor-like review).
 *
 * The old review was whole-file: one bar after the last changed line with
 * Keep / Revert for the entire edit. This model splits the same change into
 * its independent hunks and tracks one decision per hunk, so the editor can
 * accept or reject a single block of changed lines and move on to the next.
 *
 * Pure functions only — no React, no CodeMirror, no storage. The editor owns
 * the live document and the disk writes; this module answers:
 *
 * - which hunks the change consists of ({@link buildPendingReview}),
 * - what the file's text is after any set of decisions ({@link reviewText}),
 * - where each hunk sits in the reconstructed document
 *   ({@link hunkPositions}), the coordinates the inline widgets use,
 * - and what the next state is after one decision or a bulk action
 *   ({@link keepReviewHunk}, {@link rejectReviewHunk},
 *   {@link keepAllReviewHunks}, {@link rejectAllPendingHunks},
 *   {@link undoReviewStep}).
 *
 * ## The model
 *
 * `base` is the file's bytes before the agent's change, `target` the bytes
 * after it. The review keeps the diff as a flat, ordered row list
 * ({@link ReviewRow}) — target lines in place, each changed row carrying its
 * OLD-side text when it has one. A row belongs to at most one hunk
 * ({@link ReviewHunk.rowStart}/`rowEnd`), and {@link reviewText} walks those
 * rows once:
 *
 * - a `context` row is shared by both sides — always emitted;
 * - inside a kept (or pending) hunk a `del` row disappears while `add`/`mod`
 *   rows emit their NEW text;
 * - inside a rejected hunk a `del` row emits its OLD text, an `add` row
 *   disappears and a `mod` row emits its OLD text.
 *
 * Walking rows (instead of splicing line ranges) is what makes several
 * deleted blocks around one anchor reconstruct in the right order: each `del`
 * row restores its own text at its own place.
 */

import { diffLines, type DiffRow } from './rows.ts'

/** How many steps of the review one Ctrl+Z can walk back. */
export const REVIEW_UNDO_LIMIT = 12

/**
 * One review row: a diff row plus, for a rewritten line, which side it is.
 *
 * 'mod' rows come in pairs (the shared renderer marks a rewritten del/add
 * pair with the SAME text on both rows), and the pair can interleave with a
 * plain 'del' row, so {@link ReviewRow.newSide} — not adjacency — says which
 * half a mod row is. The replaced text itself is carried by the hunk
 * ({@link ReviewHunk.oldLines}).
 */
export interface ReviewRow {
  readonly kind: 'context' | 'del' | 'add' | 'mod' | 'meta'
  /** The row's own text (the new side for 'add'/'mod', the removed text for
   *  'del'). */
  readonly text: string
  /** For a 'mod' row: true when it is the replacement half. */
  readonly newSide?: boolean
}

/** One changed block of a pending review. */
export interface ReviewHunk {
  /** Stable identity within its review: the hunk's ordinal, 0-based. */
  readonly id: number
  /** The block's replacing lines (what the agent wrote). */
  readonly newLines: readonly string[]
  /** The block's removed lines (plain deletions only — a rewritten line's
   *  replaced text lives on its `mod` row inside the hunk's rows). */
  readonly oldLines: readonly string[]
  /** How many of {@link oldLines} came from rewritten ('mod') pairs rather
   *  than plain deletions — the tail of the list, in the diff's order. */
  readonly rewritten: number
  /** The hunk's diff-row indices, ascending. Grouped hunks cover a contiguous
   *  run; a line-level hunk is one changed line (a rewrite's two halves). */
  readonly rows: readonly number[]
  /** Index of the hunk's first row (inclusive). */
  readonly rowStart: number
  /** Index of the hunk's last row (inclusive). */
  readonly rowEnd: number
  /** Whether the block has been decided (kept or rejected) yet. */
  readonly decision: 'pending' | 'keep' | 'reject'
}

/** The state of one file's pending review. */
export interface PendingReview {
  readonly splitLines?: boolean
  /** The reviewed file (absolute). */
  readonly path: string
  /** The file's bytes before the change: every rejected hunk restores them. */
  readonly base: string
  /** The file's bytes after the change (the reviewed document). */
  readonly target: string
  /** The change's rows, in document order (see the module comment). */
  readonly rows: readonly ReviewRow[]
  /** The changed blocks, in document order. */
  readonly hunks: readonly ReviewHunk[]
  /** The hunk the action bar is on; null when nothing is pending. */
  readonly active: number | null
  /** Whether every hunk has a decision (the review is finished). */
  readonly decided: boolean
}

/** What one Ctrl+Z walks back. */
export type ReviewUndo =
  /** One hunk's decision. */
  | { readonly kind: 'hunk'; readonly id: number; readonly activeBefore: number | null }
  /** The whole review being dismissed or restored. */
  | { readonly kind: 'review'; readonly review: PendingReview; readonly textBefore: string; readonly textAfter: string }

/** A pending review plus the text one action must write. */
export interface ReviewStep {
  readonly review: PendingReview
  /** Text to write; null when the action did not move the document. */
  readonly text: string | null
  readonly undo: ReviewUndo
}

/** Whether a diff row is part of a changed run. */
function isChange(row: DiffRow): boolean {
  return row.kind === 'add' || row.kind === 'del' || row.kind === 'mod'
}

/**
 * Turn the shared diff rows into review rows. A 'mod' row's side is read from
 * its line numbers: the old half has an old-side line and no new-side line,
 * the replacement the reverse (see the shared engine's `pairMods`).
 * @param rows - the shared diff rows.
 * @returns the flat review rows.
 */
export function reviewRowsOf(rows: readonly DiffRow[]): ReviewRow[] {
  return rows.map(row => (row.kind === 'mod'
    ? { kind: 'mod' as const, text: row.text, newSide: row.newLine !== undefined && row.oldLine === undefined }
    : { kind: row.kind, text: row.text }))
}

/**
 * Split an old/new document pair into the review's hunks. By default each
 * maximal changed run is one decision (the editor's block review); with
 * `splitLines` each changed LINE is its own decision instead (the changes
 * page's per-line confirm), with a rewrite's two halves kept together.
 * Anchors are resolved at render time by {@link hunkPositions}, because they
 * move as hunks are decided.
 * @param base - the file's bytes before the change.
 * @param target - the file's bytes after the change.
 * @param path - the reviewed file.
 * @param options - `splitLines` makes each changed line its own hunk.
 * @returns the pending review (empty hunk list when nothing changed).
 */
export function buildPendingReview(
  base: string,
  target: string,
  path: string,
  options?: { readonly splitLines?: boolean },
): PendingReview {
  const diff = diffLines(base, target)
  const rows = reviewRowsOf(diff)
  const hunks: ReviewHunk[] = []
  let i = 0
  while (i < rows.length) {
    if (!isChange(diff[i]!)) { i += 1; continue }
    let j = i
    while (j < rows.length && isChange(diff[j]!)) j += 1
    if (options?.splitLines === true) {
      for (const unit of lineUnitsOf(rows, i, j)) {
        hunks.push({ id: hunks.length, ...unit, rowStart: unit.rows[0]!, rowEnd: unit.rows[unit.rows.length - 1]!, decision: 'pending' })
      }
    } else {
      const oldLines: string[] = []
      const newLines: string[] = []
      let rewritten = 0
      for (let k = i; k < j; k += 1) {
        const row = rows[k]!
        // A plain deletion keeps its text here (the "removed" block of the
        // inline diff); a rewrite's old half is carried by its row, and the
        // pair count is what the UI uses to label it.
        if (row.kind === 'del') oldLines.push(row.text)
        else if (row.kind === 'add') newLines.push(row.text)
        else if (row.kind === 'mod') {
          if (row.newSide === true) newLines.push(row.text)
          else rewritten += 1
        }
      }
      const rowsOfRun: number[] = []
      for (let k = i; k < j; k += 1) rowsOfRun.push(k)
      hunks.push({
        id: hunks.length,
        oldLines,
        newLines,
        rewritten,
        rows: rowsOfRun,
        rowStart: i,
        rowEnd: j - 1,
        decision: 'pending',
      })
    }
    i = j
  }
  return {
    path,
    base,
    target,
    splitLines: options?.splitLines === true,
    rows,
    hunks,
    active: hunks.length > 0 ? 0 : null,
    decided: hunks.length === 0,
  }
}

/** One line-level decision unit: a rewritten pair, an added line or a deleted line. */
interface LineUnit {
  readonly rows: readonly number[]
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
  readonly rewritten: number
}

/**
 * Break one changed run into per-line units, in document order. A rewrite's
 * old and new halves pair up by their order inside the run (the shared
 * engine emits them in lockstep); an unmatched half becomes a deletion or an
 * addition of its own.
 */
function lineUnitsOf(rows: readonly ReviewRow[], from: number, to: number): LineUnit[] {
  const oldHalves: number[] = []
  const newHalves: number[] = []
  for (let k = from; k <= to; k += 1) {
    const row = rows[k]!
    if (row.kind !== 'mod') continue
    if (row.newSide === true) newHalves.push(k)
    else oldHalves.push(k)
  }
  const paired = new Map<number, number>()
  const pairedNew = new Set<number>()
  const count = Math.min(oldHalves.length, newHalves.length)
  for (let index = 0; index < count; index += 1) {
    paired.set(oldHalves[index]!, newHalves[index]!)
    pairedNew.add(newHalves[index]!)
  }
  const units: LineUnit[] = []
  for (let k = from; k <= to; k += 1) {
    const row = rows[k]!
    if (row.kind === 'del') {
      units.push({ rows: [k], oldLines: [row.text], newLines: [], rewritten: 0 })
      continue
    }
    if (row.kind === 'add') {
      units.push({ rows: [k], oldLines: [], newLines: [row.text], rewritten: 0 })
      continue
    }
    if (row.kind !== 'mod') continue
    if (row.newSide === true) {
      // Emitted with its old half (paired) or as a standalone addition.
      if (!pairedNew.has(k)) units.push({ rows: [k], oldLines: [], newLines: [row.text], rewritten: 0 })
      continue
    }
    const newHalf = paired.get(k)
    if (newHalf === undefined) {
      // An unmatched old half is a plain removed line.
      units.push({ rows: [k], oldLines: [row.text], newLines: [], rewritten: 0 })
      continue
    }
    units.push({
      rows: [k, newHalf],
      oldLines: [],
      newLines: [rows[newHalf]!.text],
      rewritten: 1,
    })
  }
  return units
}

/** One hunk's place in the current document, keyed by id. */
export interface HunkPlacement {
  readonly anchor: number
  readonly lines: number
}

/** One walk's result: the text to write plus where every hunk is. */
export interface ReviewWalk {
  readonly text: string
  readonly placements: ReadonlyMap<number, HunkPlacement>
}

/**
 * Walk the review's rows once, producing BOTH the document text and every
 * hunk's anchor, so the decorations and the bytes can never disagree.
 * @param review - the review state.
 * @returns the reconstructed text and each hunk's placement.
 */
export function walkReview(review: PendingReview): ReviewWalk {
  const placements = new Map<number, HunkPlacement>()
  if (review.rows.length === 0) return { text: review.target, placements }
  const hunkAt = new Map<number, ReviewHunk>()
  for (const hunk of review.hunks) {
    for (const row of hunk.rows) hunkAt.set(row, hunk)
  }
  const out: string[] = []
  let line = 0
  for (let index = 0; index < review.rows.length; index += 1) {
    const hunk = hunkAt.get(index)
    if (hunk !== undefined && index === hunk.rows[0]) {
      placements.set(hunk.id, { anchor: line, lines: hunk.decision === 'reject' ? 0 : hunk.newLines.length })
    }
    const row = review.rows[index]!
    const rejected = hunk?.decision === 'reject'
    switch (row.kind) {
      case 'context':
        out.push(row.text)
        line += 1
        break
      case 'del':
        // A deleted line comes back only when its hunk is rejected.
        if (rejected) { out.push(row.text); line += 1 }
        break
      case 'mod':
        // Each rewrite is one old line plus one new line: a keep emits only
        // the new half (the target already holds it), a rejection only the
        // old half.
        if (rejected ? row.newSide !== true : row.newSide === true) {
          out.push(row.text)
          line += 1
        }
        break
      case 'add':
        if (!rejected) { out.push(row.text); line += 1 }
        break
      case 'meta':
        break
    }
  }
  return { text: out.join('\n'), placements }
}

/**
 * The file's text after the review's current decisions. An unfinished hunk
 * counts as kept, because that is what is on disk until it is rejected.
 * @param review - the review state.
 * @returns the reconstructed document text.
 */
export function reviewText(review: PendingReview): string {
  return walkReview(review).text
}

/**
 * Where every hunk sits in the reconstructed document.
 * @param review - the review state.
 * @returns each hunk's anchor line (0 = the file's top) and emitted lines.
 */
export function hunkPositions(review: PendingReview): ReadonlyMap<number, HunkPlacement> {
  return walkReview(review).placements
}

/** Where one hunk is, from {@link hunkPositions}. */
export function hunkPosition(review: PendingReview, id: number): HunkPlacement | undefined {
  return hunkPositions(review).get(id)
}

/** The next still-pending hunk after `id` (wrapping), or null. */
export function nextPending(id: number, hunks: readonly ReviewHunk[]): number | null {
  if (hunks.length === 0) return null
  const from = hunks.findIndex(hunk => hunk.id === id)
  for (let step = 1; step <= hunks.length; step += 1) {
    const hunk = hunks[(from + step) % hunks.length]!
    if (hunk.decision === 'pending') return hunk.id
  }
  return null
}

/** The previous still-pending hunk before `id` (wrapping), or null. */
export function previousPending(id: number, hunks: readonly ReviewHunk[]): number | null {
  if (hunks.length === 0) return null
  const from = hunks.findIndex(hunk => hunk.id === id)
  for (let step = 1; step <= hunks.length; step += 1) {
    const index = (((from - step) % hunks.length) + hunks.length) % hunks.length
    const hunk = hunks[index]!
    if (hunk.decision === 'pending') return hunk.id
  }
  return null
}

/** The hunk the action bar should show: the active one while pending, else
 *  the first pending hunk, else null. */
export function activeHunkOf(review: PendingReview): number | null {
  if (review.active !== null && review.hunks.some(hunk => hunk.id === review.active && hunk.decision === 'pending')) {
    return review.active
  }
  return review.hunks.find(hunk => hunk.decision === 'pending')?.id ?? null
}

/**
 * Set one hunk's decision and move the action bar on to the next pending
 * hunk. Positions are derived from the rows, so nothing shifts as decisions
 * accumulate.
 * @param review - the review state.
 * @param id - the hunk to decide.
 * @param decision - the new decision.
 * @returns the updated review (the same object when nothing changed).
 */
export function setReviewDecision(review: PendingReview, id: number, decision: ReviewHunk['decision']): PendingReview {
  const index = review.hunks.findIndex(hunk => hunk.id === id)
  if (index === -1 || review.hunks[index]!.decision === decision) return review
  const hunks = review.hunks.map((hunk, i) => (i === index ? { ...hunk, decision } : hunk))
  return {
    ...review,
    hunks,
    decided: hunks.every(hunk => hunk.decision !== 'pending'),
    active: nextPending(id, hunks),
  }
}

/** Reject one hunk: its rows fall back to the old side. */
export function rejectReviewHunk(review: PendingReview, id: number): ReviewStep {
  const activeBefore = activeHunkOf(review)
  const updated = setReviewDecision(review, id, 'reject')
  return {
    review: updated,
    text: updated === review ? null : reviewText(updated),
    undo: { kind: 'hunk', id, activeBefore },
  }
}

/** Keep one hunk: the document already holds its lines. */
export function keepReviewHunk(review: PendingReview, id: number): ReviewStep {
  const activeBefore = activeHunkOf(review)
  return { review: setReviewDecision(review, id, 'keep'), text: null, undo: { kind: 'hunk', id, activeBefore } }
}

/** Keep every still-pending hunk; one step, one undo entry. */
export function keepAllReviewHunks(review: PendingReview): ReviewStep {
  const hunks = review.hunks.map(hunk => (hunk.decision === 'pending' ? { ...hunk, decision: 'keep' as const } : hunk))
  const updated: PendingReview = { ...review, hunks, decided: hunks.every(hunk => hunk.decision !== 'pending'), active: null }
  return {
    review: updated,
    text: null,
    undo: { kind: 'review', review, textBefore: review.target, textAfter: reviewText(updated) },
  }
}

/** Reject every still-pending hunk. */
export function rejectAllPendingHunks(review: PendingReview): ReviewStep {
  const hunks = review.hunks.map(hunk => (hunk.decision === 'pending' ? { ...hunk, decision: 'reject' as const } : hunk))
  const updated: PendingReview = { ...review, hunks, decided: hunks.every(hunk => hunk.decision !== 'pending'), active: null }
  return {
    review: updated,
    text: reviewText(updated),
    undo: { kind: 'review', review, textBefore: review.target, textAfter: reviewText(updated) },
  }
}

/**
 * Undo one step.
 *
 * - A single hunk goes back to `pending`, so the bar asks again.
 * - A whole review (a bulk action, or the review being dismissed) re-opens
 *   with every hunk pending.
 * @param current - the review the undo entry belongs to.
 * @param undo - the step to walk back.
 * @returns the restored review and the text to write, if any.
 */
export function undoReviewStep(current: PendingReview, undo: ReviewUndo): { review: PendingReview; text: string | null } {
  if (undo.kind === 'review') {
    const restored: PendingReview = {
      ...undo.review,
      hunks: undo.review.hunks.map(hunk => ({ ...hunk, decision: 'pending' as const })),
      active: undo.review.hunks.length > 0 ? undo.review.hunks[0]!.id : null,
      decided: undo.review.hunks.length === 0,
    }
    return { review: restored, text: reviewText(restored) }
  }
  const previous = current.hunks.find(hunk => hunk.id === undo.id)
  const restored = { ...setReviewDecision(current, undo.id, 'pending'), active: undo.id }
  const text = previous?.decision === 'reject' ? reviewText(restored) : null
  return { review: restored, text }
}

/** Counts for the review bar and its persisted copy. */
export function reviewSummary(review: PendingReview): {
  total: number
  pending: number
  kept: number
  rejected: number
} {
  let pending = 0
  let kept = 0
  let rejected = 0
  for (const hunk of review.hunks) {
    if (hunk.decision === 'pending') pending += 1
    else if (hunk.decision === 'keep') kept += 1
    else rejected += 1
  }
  return { total: review.hunks.length, pending, kept, rejected }
}

/** One persisted review (localStorage), version 2. */
export interface StoredPendingReview {
  readonly splitLines?: boolean
  readonly version: 2
  readonly path: string
  readonly base: string
  readonly target: string
  readonly decisions: readonly { readonly id: number; readonly decision: ReviewHunk['decision'] }[]
  readonly active: number | null
}

/** Serialize a review for localStorage. Only the decisions are stored: the
 *  rows and the hunk ranges are rebuilt from `base`/`target` on restore. */
export function storePendingReview(review: PendingReview): StoredPendingReview {
  return {
    version: 2,
    path: review.path,
    base: review.base,
    target: review.target,
    splitLines: review.splitLines === true,
    decisions: review.hunks.map(hunk => ({ id: hunk.id, decision: hunk.decision })),
    active: review.active,
  }
}

/** Rebuild a persisted review, re-applying its recorded decisions. */
export function readStoredPendingReview(value: unknown, path: string): PendingReview | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Partial<StoredPendingReview>
  if (raw.version !== 2 || raw.path !== path) return null
  if (typeof raw.base !== 'string' || typeof raw.target !== 'string') return null
  if (!Array.isArray(raw.decisions)) return null
  const base = buildPendingReview(raw.base, raw.target, path, { splitLines: raw.splitLines === true })
  const decisions = new Map<number, ReviewHunk['decision']>()
  for (const item of raw.decisions) {
    if (item === null || typeof item !== 'object') return null
    const entry = item as { id?: unknown; decision?: unknown }
    if (typeof entry.id !== 'number') return null
    if (entry.decision !== 'pending' && entry.decision !== 'keep' && entry.decision !== 'reject') return null
    decisions.set(entry.id, entry.decision)
  }
  let review = base
  for (const hunk of base.hunks) {
    const decision = decisions.get(hunk.id)
    if (decision !== undefined && decision !== 'pending') review = setReviewDecision(review, hunk.id, decision)
  }
  const active = typeof raw.active === 'number' ? raw.active : null
  return active === null ? review : { ...review, active }
}
