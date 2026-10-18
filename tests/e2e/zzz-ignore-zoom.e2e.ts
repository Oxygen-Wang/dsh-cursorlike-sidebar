/**
 * `.ignore` + Ctrl+wheel icon zoom lane (runs last, like zzz-ctrl-l).
 *
 * Seeds a workspace with a root `.ignore`, proves the explorer hides both the
 * ignored folder and the `*.log` file while keeping the control file visible,
 * then dispatches a Ctrl+wheel over a row and asserts the row icon grows.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { PAGE_URL, createHostApi, dismissOnboarding, hostRpc } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-ignore-zoom-lane')
const VISIBLE = 'ignore-visible.txt'
const IGNORED_FOLDER = 'ignore-demo'
const IGNORED_FILE = 'demo-ignored.log'

test('root .ignore hides matching entries and Ctrl+wheel enlarges tree icons', async ({ page }) => {
  mkdirSync(join(WORKSPACE_PATH, IGNORED_FOLDER), { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, '.ignore'), '# demo\nignore-demo/\n*.log\n')
  writeFileSync(join(WORKSPACE_PATH, VISIBLE), 'keep me\n')
  writeFileSync(join(WORKSPACE_PATH, IGNORED_FILE), 'hide me\n')
  writeFileSync(join(WORKSPACE_PATH, IGNORED_FOLDER, 'secret.txt'), 'hidden with the folder\n')

  const api = await createHostApi()
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
    await hostRpc<{ sessionId: string }>(api, 'session.create', {
      workspaceId: workspace.value.workspace.workspaceId,
    })

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
    await dismissOnboarding(page)

    const composer = page.locator('[contenteditable="true"]').first()
    await expect(composer).toBeVisible({ timeout: 60_000 })
    await composer.click()
    await page.keyboard.type('ignore lane')
    await page.keyboard.press('Enter')

    const expand = page.locator('[data-sidebar-right-expand]').first()
    await expect(expand).toBeVisible({ timeout: 60_000 })
    await expand.click()
    const guide = page.locator('[data-sidebar-right-guide]')
    await expect(guide).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()

    const pane = page.locator('[data-sidebar-right-panel]')
    const visibleRow = pane.locator(`[role="button"][title$="${VISIBLE}"]:visible`)
    await expect(visibleRow, 'the control file stays visible').toHaveCount(1, { timeout: 30_000 })
    // The `.ignore` read is its own async fs.read; give it a beat before
    // asserting the absence (the initial listing can arrive first).
    await page.waitForTimeout(1_500)
    await expect(pane.locator(`[role="button"][title$="${IGNORED_FOLDER}"]:visible`)).toHaveCount(0)
    await expect(pane.locator(`[role="button"][title$="${IGNORED_FILE}"]:visible`)).toHaveCount(0)

    const icon = visibleRow.locator(':scope > svg, :scope > span:first-child > svg').first()
    await expect(icon).toBeVisible()
    const before = (await icon.boundingBox())?.width ?? 0
    await visibleRow.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))
    })
    await expect.poll(async () => (await icon.boundingBox())?.width ?? 0, { timeout: 10_000 }).toBeGreaterThan(before)
  } finally {
    await api.dispose()
  }
})
