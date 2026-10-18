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
/** Install the default and the action colors once per document. */
export declare function installDiffApprovalPolish(): void;
