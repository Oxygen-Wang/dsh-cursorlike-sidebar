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
import { type DiffRow } from './rows.ts';
/** How many steps of the review one Ctrl+Z can walk back. */
export declare const REVIEW_UNDO_LIMIT = 12;
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
    readonly kind: 'context' | 'del' | 'add' | 'mod' | 'meta';
    /** The row's own text (the new side for 'add'/'mod', the removed text for
     *  'del'). */
    readonly text: string;
    /** For a 'mod' row: true when it is the replacement half. */
    readonly newSide?: boolean;
}
/** One changed block of a pending review. */
export interface ReviewHunk {
    /** Stable identity within its review: the hunk's ordinal, 0-based. */
    readonly id: number;
    /** The block's replacing lines (what the agent wrote). */
    readonly newLines: readonly string[];
    /** The block's removed lines (plain deletions only — a rewritten line's
     *  replaced text lives on its `mod` row inside the hunk's rows). */
    readonly oldLines: readonly string[];
    /** How many of {@link oldLines} came from rewritten ('mod') pairs rather
     *  than plain deletions — the tail of the list, in the diff's order. */
    readonly rewritten: number;
    /** The hunk's diff-row indices, ascending. Grouped hunks cover a contiguous
     *  run; a line-level hunk is one changed line (a rewrite's two halves). */
    readonly rows: readonly number[];
    /** Index of the hunk's first row (inclusive). */
    readonly rowStart: number;
    /** Index of the hunk's last row (inclusive). */
    readonly rowEnd: number;
    /** Whether the block has been decided (kept or rejected) yet. */
    readonly decision: 'pending' | 'keep' | 'reject';
}
/** The state of one file's pending review. */
export interface PendingReview {
    readonly splitLines?: boolean;
    /** The reviewed file (absolute). */
    readonly path: string;
    /** The file's bytes before the change: every rejected hunk restores them. */
    readonly base: string;
    /** The file's bytes after the change (the reviewed document). */
    readonly target: string;
    /** The change's rows, in document order (see the module comment). */
    readonly rows: readonly ReviewRow[];
    /** The changed blocks, in document order. */
    readonly hunks: readonly ReviewHunk[];
    /** The hunk the action bar is on; null when nothing is pending. */
    readonly active: number | null;
    /** Whether every hunk has a decision (the review is finished). */
    readonly decided: boolean;
}
/** What one Ctrl+Z walks back. */
export type ReviewUndo = 
/** One hunk's decision. */
{
    readonly kind: 'hunk';
    readonly id: number;
    readonly activeBefore: number | null;
}
/** The whole review being dismissed or restored. */
 | {
    readonly kind: 'review';
    readonly review: PendingReview;
    readonly textBefore: string;
    readonly textAfter: string;
};
/** A pending review plus the text one action must write. */
export interface ReviewStep {
    readonly review: PendingReview;
    /** Text to write; null when the action did not move the document. */
    readonly text: string | null;
    readonly undo: ReviewUndo;
}
/**
 * Turn the shared diff rows into review rows. A 'mod' row's side is read from
 * its line numbers: the old half has an old-side line and no new-side line,
 * the replacement the reverse (see the shared engine's `pairMods`).
 * @param rows - the shared diff rows.
 * @returns the flat review rows.
 */
export declare function reviewRowsOf(rows: readonly DiffRow[]): ReviewRow[];
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
export declare function buildPendingReview(base: string, target: string, path: string, options?: {
    readonly splitLines?: boolean;
}): PendingReview;
/** One hunk's place in the current document, keyed by id. */
export interface HunkPlacement {
    readonly anchor: number;
    readonly lines: number;
}
/** One walk's result: the text to write plus where every hunk is. */
export interface ReviewWalk {
    readonly text: string;
    readonly placements: ReadonlyMap<number, HunkPlacement>;
}
/**
 * Walk the review's rows once, producing BOTH the document text and every
 * hunk's anchor, so the decorations and the bytes can never disagree.
 * @param review - the review state.
 * @returns the reconstructed text and each hunk's placement.
 */
export declare function walkReview(review: PendingReview): ReviewWalk;
/**
 * The file's text after the review's current decisions. An unfinished hunk
 * counts as kept, because that is what is on disk until it is rejected.
 * @param review - the review state.
 * @returns the reconstructed document text.
 */
export declare function reviewText(review: PendingReview): string;
/**
 * Where every hunk sits in the reconstructed document.
 * @param review - the review state.
 * @returns each hunk's anchor line (0 = the file's top) and emitted lines.
 */
export declare function hunkPositions(review: PendingReview): ReadonlyMap<number, HunkPlacement>;
/** Where one hunk is, from {@link hunkPositions}. */
export declare function hunkPosition(review: PendingReview, id: number): HunkPlacement | undefined;
/** The next still-pending hunk after `id` (wrapping), or null. */
export declare function nextPending(id: number, hunks: readonly ReviewHunk[]): number | null;
/** The previous still-pending hunk before `id` (wrapping), or null. */
export declare function previousPending(id: number, hunks: readonly ReviewHunk[]): number | null;
/** The hunk the action bar should show: the active one while pending, else
 *  the first pending hunk, else null. */
export declare function activeHunkOf(review: PendingReview): number | null;
/**
 * Set one hunk's decision and move the action bar on to the next pending
 * hunk. Positions are derived from the rows, so nothing shifts as decisions
 * accumulate.
 * @param review - the review state.
 * @param id - the hunk to decide.
 * @param decision - the new decision.
 * @returns the updated review (the same object when nothing changed).
 */
export declare function setReviewDecision(review: PendingReview, id: number, decision: ReviewHunk['decision']): PendingReview;
/** Reject one hunk: its rows fall back to the old side. */
export declare function rejectReviewHunk(review: PendingReview, id: number): ReviewStep;
/** Keep one hunk: the document already holds its lines. */
export declare function keepReviewHunk(review: PendingReview, id: number): ReviewStep;
/** Keep every still-pending hunk; one step, one undo entry. */
export declare function keepAllReviewHunks(review: PendingReview): ReviewStep;
/** Reject every still-pending hunk. */
export declare function rejectAllPendingHunks(review: PendingReview): ReviewStep;
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
export declare function undoReviewStep(current: PendingReview, undo: ReviewUndo): {
    review: PendingReview;
    text: string | null;
};
/** Counts for the review bar and its persisted copy. */
export declare function reviewSummary(review: PendingReview): {
    total: number;
    pending: number;
    kept: number;
    rejected: number;
};
/** One persisted review (localStorage), version 2. */
export interface StoredPendingReview {
    readonly splitLines?: boolean;
    readonly version: 2;
    readonly path: string;
    readonly base: string;
    readonly target: string;
    readonly decisions: readonly {
        readonly id: number;
        readonly decision: ReviewHunk['decision'];
    }[];
    readonly active: number | null;
}
/** Serialize a review for localStorage. Only the decisions are stored: the
 *  rows and the hunk ranges are rebuilt from `base`/`target` on restore. */
export declare function storePendingReview(review: PendingReview): StoredPendingReview;
/** Rebuild a persisted review, re-applying its recorded decisions. */
export declare function readStoredPendingReview(value: unknown, path: string): PendingReview | null;
