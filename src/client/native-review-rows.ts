import { diffLines } from './diff/rows.ts'
import type { PendingReview } from './diff/review-model.ts'

export interface NativeReviewRow { element: HTMLElement; mount: HTMLElement; id: number; showActions: boolean }

/** Inline properties the resolved state owns, with each node's original value. */
const STYLE_PROPS = ['background-color', 'color', 'display'] as const
interface SavedStyle { node: HTMLElement; values: Map<string, { value: string; priority: string }> }
const styled = new WeakMap<HTMLElement, SavedStyle[]>()

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
export function applyNativeDecisionStyles(element: HTMLElement, decision: 'pending' | 'keep' | 'reject'): void {
  const saved = styled.get(element)
  if (decision === 'pending') {
    for (const entry of saved ?? []) {
      for (const [property, original] of entry.values) {
        if (original.value === '') entry.node.style.removeProperty(property)
        else entry.node.style.setProperty(property, original.value, original.priority)
      }
    }
    styled.delete(element)
    element.style.removeProperty('display')
    return
  }
  let entries = saved
  if (entries === undefined) {
    entries = [element, ...element.querySelectorAll<HTMLElement>('*')].map((node) => ({
      node,
      values: new Map(STYLE_PROPS.map(property => [property, {
        value: node.style.getPropertyValue(property),
        priority: node.style.getPropertyPriority(property),
      }] as const)),
    }))
    styled.set(element, entries)
  }
  for (const { node } of entries) {
    // Longhands only: setting the `background` shorthand with a var() fallback
    // is dropped by CSSOM parsers, and the tint is always a color layer.
    node.style.setProperty('background-color', 'transparent', 'important')
    node.style.setProperty('color', 'var(--dsw-alias-label-primary)', 'important')
  }
  element.style.setProperty('background-color', 'var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1))', 'important')
  // Only the side that survives the decision stays in the flow.
  const kind = element.dataset.diffLine
  if ((decision === 'keep' && kind === 'del') || (decision === 'reject' && kind === 'add')) {
    element.style.setProperty('display', 'none', 'important')
  } else {
    element.style.removeProperty('display')
  }
}

/** Remove every inline override this module wrote on one row. */
export function clearNativeDecisionStyles(element: HTMLElement): void {
  applyNativeDecisionStyles(element, 'pending')
}

/** Match public host line gutters in unified, wrapped split and column views. */
export function attachNativeReviewRows(root: HTMLElement, review: PendingReview): { rows: NativeReviewRow[]; dispose(): void } {
  const coordinates = new Map<string, number>()
  const source = diffLines(review.base, review.target)
  for (const hunk of review.hunks) {
    for (const index of hunk.rows) {
      const row = source[index]
      if (row?.oldLine !== undefined) coordinates.set(`old:${row.oldLine}`, hunk.id)
      if (row?.newLine !== undefined) coordinates.set(`new:${row.newLine}`, hunk.id)
    }
  }
  const rows: NativeReviewRow[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-diff-line]')) {
    if (element.dataset.diffLine === 'context') continue
    const children = [...element.children]
    const side = element.closest('[data-diff-side]')?.getAttribute('data-diff-side')
    let oldNumber: string | null = null
    let newNumber: string | null = null
    if (side !== undefined && side !== null) {
      if (side === 'old' || side === 'left') oldNumber = children[0]?.textContent ?? null
      else newNumber = children[0]?.textContent ?? null
    } else if (children.length >= 4) {
      oldNumber = children[0]?.textContent ?? null
      newNumber = children[1]?.textContent ?? null
    } else {
      oldNumber = children[0]?.children[0]?.textContent ?? null
      newNumber = children[1]?.children[0]?.textContent ?? null
    }
    const id = coordinates.get(`new:${newNumber?.trim()}`) ?? coordinates.get(`old:${oldNumber?.trim()}`)
    if (id === undefined) continue
    if (!side && children.length < 4) {
      if (oldNumber?.trim()) children[0]?.setAttribute('data-cursorlike-native-color', 'del')
      if (newNumber?.trim()) children[1]?.setAttribute('data-cursorlike-native-color', 'add')
    }
    const mount = document.createElement('span')
    mount.setAttribute('data-cursorlike-native-line-actions', '')
    element.setAttribute('data-cursorlike-native-line', String(id))
    element.setAttribute('data-cursorlike-native-layout', side ? 'column' : children.length >= 4 ? 'unified' : 'split')
    element.append(mount)
    rows.push({ element, mount, id, showActions: false })
  }
  // A contiguous changed block owns one control group, at its last visible
  // row. Both halves of a replacement still highlight/navigate together.
  const tails = new Map<number, NativeReviewRow>()
  for (const row of rows) tails.set(row.id, row)
  for (const row of rows) {
    row.showActions = tails.get(row.id) === row
    if (!row.showActions) row.mount.remove()
  }
  return { rows, dispose() {
    for (const row of rows) {
      clearNativeDecisionStyles(row.element)
      row.mount.remove()
      row.element.removeAttribute('data-cursorlike-native-line')
      row.element.removeAttribute('data-cursorlike-native-layout')
      row.element.removeAttribute('data-cursorlike-native-active')
      row.element.removeAttribute('data-cursorlike-native-decision')
      for (const cell of row.element.querySelectorAll('[data-cursorlike-native-color]')) cell.removeAttribute('data-cursorlike-native-color')
    }
  } }
}
