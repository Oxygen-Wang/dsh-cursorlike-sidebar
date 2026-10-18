import { api, type SessionScope } from './api.ts'
import { IGNORE_FILE } from './ignore-file.ts'
import { resolveSidebarPath } from './paths.ts'

/** Create only on a missing-file error; never overwrite existing rules. */
export async function ensureIgnoreFile(scope: SessionScope): Promise<{ content: string; mtimeMs?: number }> {
  if (scope.cwd === undefined) throw new Error('Workspace unavailable')
  const path = resolveSidebarPath(scope.cwd, IGNORE_FILE)
  const read = async () => {
    const result = await api.fsRead(scope, path)
    if (result.kind !== 'text') throw new Error('Cannot edit .ignore')
    return { content: result.content, mtimeMs: result.mtimeMs }
  }
  try { return await read() } catch (error) {
    const code = (error as { code?: string })?.code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    if (!/ENOENT|not[-_]found/i.test(`${code} ${message}`)) throw error
  }
  try { await api.fsCreateFile(scope, scope.cwd, IGNORE_FILE) } catch (error) {
    // Another window may have created it first. Read it without truncating.
    try { return await read() } catch { throw error }
  }
  return read()
}
