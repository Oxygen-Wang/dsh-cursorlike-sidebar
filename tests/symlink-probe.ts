/**
 * Whether this host can really create a symlink.
 *
 * Windows needs a privilege (or Developer Mode) for `symlinkSync`, and some
 * sandboxed/CI filesystems accept the call WITHOUT creating anything — so the
 * probe VERIFIES the link with `lstat` instead of trusting the exit code. A
 * host that cannot create links skips the symlink cases rather than failing
 * them on a fixture that was never there.
 */
import { lstatSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from './temp-tree.ts'

export const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-symlink-probe-'))
  try {
    const link = join(dir, 'link')
    symlinkSync('target', link)
    return lstatSync(link).isSymbolicLink()
  } catch {
    return false
  } finally {
    removeTree(dir)
  }
})()
