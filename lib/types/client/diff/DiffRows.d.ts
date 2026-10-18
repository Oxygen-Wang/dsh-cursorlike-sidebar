/**
 * The one diff renderer every file-change surface shares (the changes tab's
 * inline preview pane and the diff tab): fold-capable hunk rows with old/new
 * line gutters, rewrite (mod) tinting with intra-line character highlights,
 * lightweight syntax coloring, and long-line folding. Presentational — the
 * segments arrive precomputed (session ops via buildDiffSegments, git diffs
 * via unifiedSegments) so both producers render identically; the one
 * exception is git gap folds, whose rows git never emitted and a caller
 * supplies on demand through resolveFold (first click fetches, then they
 * toggle like any fold).
 */
import { type ReactNode } from 'react';
import { type DiffRow, type DiffSegment, type FoldSegment } from './rows.ts';
export interface DiffRowsProps {
    /** Precomputed segments (hunks and folds) for one file's diff. */
    segments: readonly DiffSegment[];
    /** Syntax language id (langOfPath); undefined renders plain text. */
    lang?: string;
    /** Fetch a git gap fold's hidden rows on demand (both sides' contents
     *  sliced by the fold's line ranges). Absent folds without `rows` — git's
     *  unemitted gaps without a resolver — stay non-expandable markers. */
    resolveFold?: (segment: FoldSegment) => Promise<readonly DiffRow[]>;
    /**
     * Optional per-hunk review overlay (the changes tab's session lens): tints
     * the active hunk's rows and renders its action bar right under the last of
     * them. `rowIndex` maps the SAME row objects the segments were built from to
     * their index in the diff, so a row can be resolved back to its review hunk.
     */
    review?: {
        readonly rowIndex: ReadonlyMap<DiffRow, number>;
        readonly hunkOfRow: ReadonlyMap<number, number>;
        readonly active: number | null;
        /** Index of the active hunk's last row (the bar renders after it). */
        readonly activeEnd: number | null;
        /** Decisions so a reverted block reads as resolved in the snapshot. */
        readonly decisionOfHunk: ReadonlyMap<number, 'pending' | 'keep' | 'reject'>;
        readonly bar: ReactNode;
        /** Per-line confirm buttons for one line-level hunk. */
        readonly rowActions?: (hunkId: number) => ReactNode;
        /** Each hunk's last row index (the buttons attach there, once). */
        readonly hunkTail?: ReadonlyMap<number, number>;
    };
}
/** One file's diff rows: fold chips between hunks, highlighted code rows. */
export declare function DiffRows({ segments, lang, resolveFold, review }: DiffRowsProps): import("react").JSX.Element;
export interface ReadRowsProps {
    /** The file lines with their real line numbers (parseReadLines output). */
    lines: ReadonlyArray<{
        line: number;
        text: string;
    }>;
    /** Syntax language id (langOfPath); undefined renders plain text. */
    lang?: string;
}
/** The read view: a line-numbered, syntax-colored slice of a read file. */
export declare function ReadRows({ lines, lang }: ReadRowsProps): import("react").JSX.Element;
