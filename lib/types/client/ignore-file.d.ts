/**
 * `.ignore` file support for the explorer: a tiny, dependency-free reader for
 * the same workspace-relative glob list the settings already use. The host's
 * `explorerExclude` matcher handles `*`, `?`, `**`, a bare name (any depth) and
 * a path-anchored `dir/name`; this module only turns the file into that list.
 *
 * Deliberate first-version limits: root-level `.ignore` only (not each
 * subdirectory), and `!` negation is skipped because the host probe is
 * positive-only — silently turning `!keep.log` into a pattern would hide the
 * wrong thing. Comments and blank lines are ignored; CRLF and LF both work.
 */
/** File the sidebar reads for per-workspace ignore rules. */
export declare const IGNORE_FILE = ".ignore";
/** Cap the parsed rules; `compileExcludePatterns` caps again on the host. */
export declare const IGNORE_PATTERN_LIMIT = 64;
/**
 * Parse a `.ignore` file into the settings' glob list.
 * @param content - the file's text.
 * @returns positive patterns in file order, at most {@link IGNORE_PATTERN_LIMIT}.
 */
export declare function parseIgnoreFile(content: string): string[];
/**
 * Append newly dropped workspace paths to a root `.ignore` text, keeping the
 * existing lines/comments and avoiding duplicates. The result always ends in
 * a newline so a later append starts on its own line.
 * @param content - the current file ('' when it does not exist).
 * @param patterns - workspace-relative positive patterns to add.
 * @returns the next file text, or the same text when nothing was added.
 */
export declare function appendIgnorePatterns(content: string, patterns: readonly string[]): string;
