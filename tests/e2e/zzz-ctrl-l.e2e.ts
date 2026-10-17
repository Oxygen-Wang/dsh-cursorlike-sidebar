/**
 * Cursor-style Ctrl/Cmd+L lane.
 *
 * Runs LAST (`zzz-` prefix): it seeds its own workspace and session, and the
 * shell persists the active session, so an earlier position could steal the
 * session the mount lane expects. It proves the three insert paths on a real
 * `dsh web` DOM:
 *   1. a CodeMirror selection inserts a fenced `path:lines` payload, even
 *      after scrolling dismissed the floating button;
 *   2. a collapsed caret inserts the current line;
 *   3. a focused explorer row inserts a structured @-reference chip.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, dismissOnboarding, hostRpc } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-ctrl-l-lane')
const FILE = 'ctrl-l-probe.txt'
const FILE_TEXT = 'alpha line\nbeta line\ngamma line\n'
const MOD_L = process.platform === 'darwin' ? 'Meta+l' : 'Control+l'

/** Count non-overlapping occurrences (payload strings repeat by design). */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** The composer draft text (Lexical contenteditable in 0.2.x). */
async function draftText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')]
    return editors.map(element => element.innerText).join('\n---\n')
  })
}

test('Ctrl+L adds a selection, the current line, and an explorer reference', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, FILE), FILE_TEXT)

  const api = await createHostApi()
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
    await hostRpc<{ sessionId: string }>(api, 'session.create', {
      workspaceId: workspace.value.workspace.workspaceId,
    })

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
    await dismissOnboarding(page)

    // Give the session content so the conversation header (and the native
    // right Sidebar's corner control) exists. The turn itself may fail on a
    // keyless boot; admission of the user message is all this needs.
    const composer = page.locator('[contenteditable="true"]').first()
    await expect(composer).toBeVisible({ timeout: 60_000 })
    await composer.click()
    await page.keyboard.type('ctrl-l lane')
    await page.keyboard.press('Enter')

    const expand = page.locator('[data-sidebar-right-expand]').first()
    await expect(expand).toBeVisible({ timeout: 60_000 })
    await expand.click()
    const guide = page.locator('[data-sidebar-right-guide]')
    await expect(guide).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()

    const pane = page.locator('[data-sidebar-right-panel]')
    const fileRow = pane.locator(`[role="button"][title$="${FILE}"]:visible`)
    await expect(fileRow, `the seeded "${FILE}" must appear in the explorer`).toHaveCount(1, { timeout: 30_000 })
    await fileRow.click({ position: { x: 8, y: 8 } })
    await expect(pane.locator('.cm-editor').first()).toBeVisible({ timeout: 30_000 })

    // 1) Selection -> fenced path:lines payload.
    await pane.locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.press(MOD_L)
    await expect.poll(() => draftText(page), { timeout: 10_000 }).toContain('alpha line')
    expect(await draftText(page)).toContain(`${FILE}:1`)

    // 1b) Scrolling dismisses the floating button; the live CodeMirror
    // selection must survive that dismissal and still insert via the shortcut.
    await pane.locator('.cm-scroller').first().evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.keyboard.press(MOD_L)
    await expect
      .poll(() => draftText(page).then(text => occurrences(text, 'alpha line')), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2)

    // 2) Collapsed caret -> the current line.
    await pane.locator('.cm-line').nth(1).click()
    await page.keyboard.press(MOD_L)
    await expect.poll(() => draftText(page), { timeout: 10_000 }).toContain('beta line')

    // 3) Explorer row -> structured @-reference (the native picker's chip).
    await pane.getByRole('tab', { name: /Files|文件/ }).first().click()
    const row = pane.locator(`[role="button"][title$="${FILE}"]:visible`)
    await row.focus()
    await page.keyboard.press(MOD_L)
    await expect
      .poll(() => page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].map(element => element.innerHTML).join('\n')), { timeout: 10_000 })
      .toContain('data-composer-chip="reference"')

    expect(pageErrors, 'pageerrors during the Ctrl+L gesture').toEqual([])
    await page.screenshot({ path: 'test-results/ctrl-l-final.png' })
  } finally {
    await api.dispose()
  }
})
