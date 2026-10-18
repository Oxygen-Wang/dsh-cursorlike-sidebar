/**
 * One selection reference inserted into the conversation: the workspace file
 * plus the selected line span. The composer gets a native `@file` chip first
 * (so the reference stays clickable), followed by a plain ` line 12-18`
 * suffix; this module owns that suffix so the popup, drag-and-drop and tests
 * agree.
 *
 * Lines are optional: a Markdown preview selection whose source line cannot be
 * located unambiguously still inserts the file reference, just without a line
 * claim (never a guessed number).
 */

/** One line span, 1-based and inclusive. */
export interface SelectionLines {
  start: number
  end: number
}

/** The payload of one selected-text reference. */
export interface SelectionReference {
  /** Absolute path of the file the selection lives in. */
  path: string
  /** The selected source lines; absent when the source line is unknown. */
  lines?: SelectionLines
}

/**
 * The plain-text suffix appended after the native file chip.
 * @param lines - the selected line span, when known.
 * @returns `' line 12-18'`, `' line 12'`, or `''`.
 */
export function lineSuffix(lines?: SelectionLines): string {
  if (lines === undefined) return ''
  const start = Math.max(1, Math.trunc(lines.start))
  const end = Math.max(start, Math.trunc(lines.end))
  return end > start ? ` line ${start}-${end}` : ` line ${start}`
}

/**
 * A text fallback for a reference whose workspace root is unavailable: the
 * absolute path followed by the same line suffix. Used only when the native
 * chip insertion cannot resolve a workspace-relative mention.
 * @param reference - the selected file/line span.
 * @returns `@C:/path/file.ts line 12-18`.
 */
export function referenceText(reference: SelectionReference): string {
  return `@${reference.path}${lineSuffix(reference.lines)}`
}
