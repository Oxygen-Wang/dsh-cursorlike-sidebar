/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export declare const SELECTION_LIMIT = 500;
/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
    start: number;
    end: number;
}
/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown (the preview reverse-search missed).
 */
export declare function headerOf(path: string, cwd: string | undefined, lines?: SelectionLines): string;
/**
 * The full text appended to the composer draft for one selection.
 * Over the limit the content is dropped: the plain path line is the whole
 * payload (an empty fenced block would just occupy the draft).
 */
export declare function buildSelectionInsert(path: string, cwd: string | undefined, lines: SelectionLines | undefined, selected: string): string;
/**
 * Map a rendered-DOM selection back to source line numbers.
 *
 * The exact source search runs first. A Markdown preview strips formatting
 * (emphasis, bullets, links, inline code, blockquotes), so when that misses we
 * search a whitespace-normalized visible projection of the source, then fall
 * back to matching the selected lines against consecutive source lines. Only
 * a single unambiguous match yields lines — an ambiguous or missing match
 * returns null (the header then carries the path without line numbers).
 */
export declare function linesOfSelection(source: string, selected: string): SelectionLines | null;
