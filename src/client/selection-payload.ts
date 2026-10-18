/**
 * Pure payload builders for the "add selection to conversation" popup in the
 * text viewers (markdown preview + the catch-all code viewer). Everything
 * here is string math — no React, no ctx — so the unit tests cover it
 * directly.
 *
 * Insert shape (agreed with the product owner):
 * - Selection ≤ SELECTION_LIMIT characters: a fenced code block whose info
 *   line is `相对路径:起止行` and whose body is the selected text.
 * - Selection over the limit: a single plain-text line `相对路径:起止行`
 *   (no fence, no content).
 * - The path is relative to the session cwd (the same projection the
 *   explorer's @ button uses); an unknown cwd falls back to the absolute
 *   path.
 * - Line numbers: single-line selections write `path:12`, multi-line write
 *   `path:12-15`. The markdown preview cannot map rendered DOM back to
 *   source lines directly, so it reverse-searches the selected text in the
 *   source and only reports lines on an unambiguous hit (see
 *   {@link linesOfSelection}).
 */
import { relativeTo } from './paths.ts'

/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export const SELECTION_LIMIT = 500

/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
  start: number
  end: number
}

/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown (the preview reverse-search missed).
 */
export function headerOf(path: string, cwd: string | undefined, lines?: SelectionLines): string {
  const rel = cwd !== undefined ? relativeTo(cwd, path) : path
  if (lines === undefined) return rel
  if (lines.end > lines.start) return `${rel}:${lines.start}-${lines.end}`
  return `${rel}:${lines.start}`
}

/**
 * The full text appended to the composer draft for one selection.
 * Over the limit the content is dropped: the plain path line is the whole
 * payload (an empty fenced block would just occupy the draft).
 */
export function buildSelectionInsert(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
): string {
  const header = headerOf(path, cwd, lines)
  if (selected.length > SELECTION_LIMIT) return header
  return `\`\`\`${header}\n${selected}\n\`\`\``
}

/** 1-based line number of a character index in a text. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/** Remove whitespace exactly the way a rendered selection comparison needs. */
function normalizedSelection(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[•◦▪▫]\s*)/, ''))
    .join('')
    .replace(/\s+/g, '')
    .replace(/[•◦▪▫]/g, '')
}

/**
 * Strip the Markdown syntax that a rendered preview no longer shows, keeping
 * only the text a reader can select: blockquote/list/heading markers, link
 * destinations, inline-code backticks, emphasis markers, HTML tags and table
 * pipes. Whitespace is removed so rendered spacing differences (for example
 * the gap after a bold label) do not break the match. This is deliberately
 * line-local; the line-number mapping stays exact.
 * @param line - one source line.
 * @returns its visible text.
 */
function visibleSourceLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:>\s?)+/, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\|/g, '')
    .replace(/\s+/g, '')
}

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
export function linesOfSelection(source: string, selected: string): SelectionLines | null {
  const text = selected.endsWith('\n') ? selected.slice(0, -1) : selected
  if (text === '') return null
  const at = source.indexOf(text)
  if (at !== -1 && source.indexOf(text, at + 1) === -1) {
    return {
      start: lineAt(source, at),
      end: lineAt(source, at + Math.max(text.length - 1, 0)),
    }
  }

  const wanted = normalizedSelection(text)
  if (wanted === '') return null
  const sourceLines = source.split('\n')
  const visible = sourceLines.map(visibleSourceLine)
  let joined = ''
  const lineMap: number[] = []
  for (let index = 0; index < visible.length; index++) {
    const part = visible[index] ?? ''
    if (part === '') continue
    for (let offset = 0; offset < part.length; offset++) {
      joined += part[offset]
      lineMap.push(index + 1)
    }
  }
  if (joined === '') return null

  const normalizedAt = joined.indexOf(wanted)
  if (normalizedAt !== -1 && joined.indexOf(wanted, normalizedAt + 1) === -1) {
    const start = lineMap[normalizedAt]
    const end = lineMap[normalizedAt + wanted.length - 1]
    if (start !== undefined && end !== undefined) return { start, end }
  }

  // Formatting-normalized full-text matching can still be ambiguous (the same
  // sentence appears twice). Selected line chunks give a second, independent
  // check that also handles a selection whose paragraph breaks differ.
  const chunks = text.split(/\r?\n/).map(normalizedSelection).filter(chunk => chunk !== '')
  if (chunks.length === 0) return null
  const candidates: SelectionLines[] = []
  for (let start = 0; start < visible.length; start++) {
    let cursor = start
    let last = start
    let ok = true
    for (const chunk of chunks) {
      let found = -1
      for (let index = cursor; index < visible.length; index++) {
        if ((visible[index] ?? '').includes(chunk)) {
          found = index
          break
        }
      }
      if (found === -1) {
        ok = false
        break
      }
      last = found
      cursor = found + 1
    }
    if (ok) candidates.push({ start: start + 1, end: last + 1 })
  }
  if (candidates.length === 1) return candidates[0] ?? null
  return null
}
