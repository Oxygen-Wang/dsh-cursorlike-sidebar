/**
 * The full-document basis behind one session op's diff, for the changes tab's
 * per-hunk review.
 *
 * The session lens renders an op as a diff of the documents the model touched
 * (`diffOf` in DiffPane). Applying a decision per hunk means writing whole
 * documents back, so the same pair must be reconstructable EXACTLY — never a
 * fragment window, because writing a window back would truncate the file.
 *
 * `prior` is the content the session knew for the path before the op (see
 * `knownContentBefore`). An edit can only be reviewed when that prior content
 * still contains its `oldString`; without it there is no safe base, and the
 * caller shows the plain read-only diff instead.
 */
import type { FileOp } from './ops.ts'

/** The old/new documents behind one op. */
export interface OpReviewBasis {
  /** The file's bytes before the op. */
  readonly base: string
  /** The file's bytes after the op. */
  readonly target: string
}

/**
 * Reconstruct the two documents behind an op's diff, or null when that is not
 * safely possible (read/error/running ops, an edit whose prior content is
 * unknown, a write over unknown prior content).
 * @param op - the session op.
 * @param prior - the content the session knew before the op.
 * @returns the review basis, or null.
 */
export function reviewBasisOf(op: FileOp, prior: string | undefined): OpReviewBasis | null {
  if (op.isError || op.running) return null
  if (op.kind === 'edit' && op.edit !== undefined) {
    if (prior === undefined || !prior.includes(op.edit.oldString)) return null
    return { base: prior, target: prior.replace(op.edit.oldString, op.edit.newString) }
  }
  if (op.kind === 'write' && op.content !== undefined) {
    if (prior === undefined || prior === op.content) return null
    return { base: prior, target: op.content }
  }
  return null
}

/** Whether two spellings are the same document (line endings normalized). */
export function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}
