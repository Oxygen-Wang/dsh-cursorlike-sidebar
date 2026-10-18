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
