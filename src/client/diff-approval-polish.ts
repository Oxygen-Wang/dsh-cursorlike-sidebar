/**
 * Small integration polish for the separately installed `dsh-diff-approval`
 * plugin:
 *
 * - its review panel defaults to the native right sidebar (`dock`) when the
 *   user has not chosen a presentation yet; an explicit float choice is kept;
 * - its Keep actions render green and Revert actions red, matching the action
 *   colors used by the sidebar's own review bar.
 *
 * The other plugin owns the panel, so the color rules target its stable
 * `data-diff-*` action markers and live in a global style tag.
 */

const PRESENTATION_KEY = 'diff-approval:presentation'
const MIGRATION_KEY = 'dsh-cursorlike:diff-approval-dock-v1'
const STYLE_ID = 'dsh-cursorlike-diff-approval-actions'

/** Install the default and the action colors once per document. */
export function installDiffApprovalPolish(): void {
  try {
    // One-time migration: existing profiles may still carry the old `float`
    // default. Move them to `dock` once; a later explicit float choice wins.
    if (localStorage.getItem(MIGRATION_KEY) === null) {
      localStorage.setItem(MIGRATION_KEY, '1')
      if (localStorage.getItem(PRESENTATION_KEY) !== 'dock') {
        localStorage.setItem(PRESENTATION_KEY, 'dock')
      }
    }
  } catch {
    /* storage unavailable: leave the other plugin's own default */
  }
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
[data-diff-block-keep], [data-diff-selection-keep], [data-diff-keep],
[data-diff-confirm-keep], [data-diff-file-confirm-keep] {
  color: var(--dsw-alias-state-success-primary) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-border-l1)) !important;
}
[data-diff-block-keep]:hover, [data-diff-selection-keep]:hover, [data-diff-keep]:hover,
[data-diff-confirm-keep]:hover, [data-diff-file-confirm-keep]:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent) !important;
}
[data-diff-block-revert], [data-diff-selection-revert], [data-diff-revert] {
  color: var(--dsw-alias-danger) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-danger) 55%, var(--dsw-alias-border-l1)) !important;
}
[data-diff-block-revert]:hover, [data-diff-selection-revert]:hover, [data-diff-revert]:hover {
  background: color-mix(in srgb, var(--dsw-alias-danger) 14%, transparent) !important;
}
`
  document.head.append(style)
}
