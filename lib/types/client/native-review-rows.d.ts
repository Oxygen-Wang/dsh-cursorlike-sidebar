import type { PendingReview } from './diff/review-model.ts';
export interface NativeReviewRow {
    element: HTMLElement;
    mount: HTMLElement;
    id: number;
    showActions: boolean;
}
/**
 * Paint one block's resolved state directly on its host rows.
 *
 * The official diff paints red/green with styles we do not own (and which can
 * live on descendants), so a stylesheet-only override is not reliable. Writing
 * the normal-file look inline — and remembering each node's ORIGINAL inline
 * values — makes "approved looks like ordinary content" and "Ctrl+Z brings the
 * comparison back" deterministic, even when the host itself styles lines
 * inline.
 * @param element - one host diff row (`[data-diff-line]`).
 * @param decision - the block's current decision.
 */
export declare function applyNativeDecisionStyles(element: HTMLElement, decision: 'pending' | 'keep' | 'reject'): void;
/** Remove every inline override this module wrote on one row. */
export declare function clearNativeDecisionStyles(element: HTMLElement): void;
/** Match public host line gutters in unified, wrapped split and column views. */
export declare function attachNativeReviewRows(root: HTMLElement, review: PendingReview): {
    rows: NativeReviewRow[];
    dispose(): void;
};
