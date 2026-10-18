/**
 * The diff-approval integration: default presentation is dock only while the
 * user has no explicit choice, and Keep/Revert action markers get the green /
 * red global rules.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { installDiffApprovalPolish } from '../src/client/diff-approval-polish.ts'

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = ''
})

describe('diff-approval polish', () => {
  it('defaults the panel to dock and leaves an explicit float choice alone', () => {
    installDiffApprovalPolish()
    expect(localStorage.getItem('diff-approval:presentation')).toBe('dock')
    expect(document.getElementById('dsh-cursorlike-diff-approval-actions')).not.toBeNull()

    localStorage.setItem('diff-approval:presentation', 'float')
    installDiffApprovalPolish()
    expect(localStorage.getItem('diff-approval:presentation')).toBe('float')
    expect(document.querySelectorAll('#dsh-cursorlike-diff-approval-actions')).toHaveLength(1)
  })

  it('migrates an existing float choice to dock once', () => {
    localStorage.setItem('diff-approval:presentation', 'float')
    installDiffApprovalPolish()
    expect(localStorage.getItem('diff-approval:presentation')).toBe('dock')
  })

  it('styles the keep and revert action markers', () => {
    installDiffApprovalPolish()
    const text = document.getElementById('dsh-cursorlike-diff-approval-actions')?.textContent ?? ''
    expect(text).toContain('[data-diff-block-keep]')
    expect(text).toContain('[data-diff-block-revert]')
    expect(text).toContain('--dsw-alias-state-success-primary')
    expect(text).toContain('--dsw-alias-danger')
  })
})
