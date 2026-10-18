import { type PendingReview } from './review-model.ts';
/** A saved decision is usable only when its reconstruction still matches disk. */
export declare function loadDiffReview(sessionId: string, identity: string, path: string, disk: string): PendingReview | null;
export declare function saveDiffReview(sessionId: string, identity: string, review: PendingReview): void;
/**
 * Restore the review's "undo last decision" history. The host can remount the
 * official review card (a refresh, a view switch), which would otherwise drop
 * the in-memory stack and leave Ctrl+Z apparently broken after an approval.
 */
export declare function loadDiffReviewUndo(sessionId: string, identity: string, path: string): PendingReview[];
export declare function saveDiffReviewUndo(sessionId: string, identity: string, stack: readonly PendingReview[]): void;
/** Forget one op's saved review (used when a new revision supersedes it). */
export declare function clearDiffReview(sessionId: string, identity: string): void;
