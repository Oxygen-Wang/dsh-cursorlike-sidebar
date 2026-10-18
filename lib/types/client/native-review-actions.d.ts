interface Hunk {
    newStart: number;
    lines: string[];
}
/** Reverse only matching changed ranges, preserving the rest of the live file. */
export declare function reverseReviewText(content: string, hunks: Hunk[]): string;
/** Official deliverables.review.file.actions slot, independent of diff-approval. */
export declare function NativeReviewActions({ actionUrl }: {
    actionUrl: string;
}): import("react").JSX.Element;
export {};
