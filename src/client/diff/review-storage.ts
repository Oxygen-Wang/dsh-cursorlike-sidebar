import { readStoredPendingReview, reviewText, storePendingReview, type PendingReview } from './review-model.ts'

/** Skip persistence for documents too large for the browser's storage quota;
 *  the review still works for the session, it just cannot survive a reload. */
const MAX_STORED_TEXT = 400_000
/** Undo states are whole review snapshots; keep the last few only. */
const UNDO_LIMIT = 12
/** A stack larger than this is dropped rather than filling the quota. */
const MAX_UNDO_BYTES = 1_500_000

function key(sessionId: string, identity: string): string {
  return `dsh-sidebar:diff-review:v1:${encodeURIComponent(sessionId)}:${encodeURIComponent(identity)}`
}

function undoKey(sessionId: string, identity: string): string {
  return `dsh-sidebar:diff-review-undo:v1:${encodeURIComponent(sessionId)}:${encodeURIComponent(identity)}`
}

/** Line endings are a spelling of the same document, not a different one. */
function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** A saved decision is usable only when its reconstruction still matches disk. */
export function loadDiffReview(sessionId: string, identity: string, path: string, disk: string): PendingReview | null {
  try {
    const raw = localStorage.getItem(key(sessionId, identity))
    if (raw === null) return null
    const review = readStoredPendingReview(JSON.parse(raw), path)
    return review !== null && normalized(reviewText(review)) === normalized(disk) ? review : null
  } catch { return null }
}

export function saveDiffReview(sessionId: string, identity: string, review: PendingReview): void {
  if (review.base.length > MAX_STORED_TEXT || review.target.length > MAX_STORED_TEXT) return
  try {
    localStorage.setItem(key(sessionId, identity), JSON.stringify(storePendingReview(review)))
  } catch { /* Storage may be unavailable; never interrupt a completed write. */ }
}

/**
 * Restore the review's "undo last decision" history. The host can remount the
 * official review card (a refresh, a view switch), which would otherwise drop
 * the in-memory stack and leave Ctrl+Z apparently broken after an approval.
 */
export function loadDiffReviewUndo(sessionId: string, identity: string, path: string): PendingReview[] {
  try {
    const raw = localStorage.getItem(undoKey(sessionId, identity))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
    const stack: PendingReview[] = []
    for (const entry of parsed.entries) {
      const review = readStoredPendingReview(entry, path)
      if (review !== null) stack.push(review)
    }
    return stack.slice(-UNDO_LIMIT)
  } catch {
    return []
  }
}

export function saveDiffReviewUndo(sessionId: string, identity: string, stack: readonly PendingReview[]): void {
  try {
    // Keep the NEWEST entries that fit: a single large snapshot is still worth
    // one undo step even when twelve would blow the quota.
    const entries: unknown[] = []
    let bytes = 0
    for (const review of [...stack].reverse()) {
      const entry = storePendingReview(review)
      const size = JSON.stringify(entry).length + 1
      if (entries.length > 0 && bytes + size > MAX_UNDO_BYTES) break
      entries.push(entry)
      bytes += size
    }
    entries.reverse()
    localStorage.setItem(undoKey(sessionId, identity), JSON.stringify({ version: 1, entries }))
  } catch {
    /* Storage may be unavailable; the in-memory stack still works. */
  }
}

/** Forget one op's saved review (used when a new revision supersedes it). */
export function clearDiffReview(sessionId: string, identity: string): void {
  try {
    localStorage.removeItem(key(sessionId, identity))
    localStorage.removeItem(undoKey(sessionId, identity))
  } catch { /* storage unavailable */ }
}
