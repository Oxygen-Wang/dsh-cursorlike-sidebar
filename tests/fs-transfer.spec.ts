import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transferWorkspaceEntry } from '../src/fs-operations.ts'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursorlike-transfer-'))
  await mkdir(join(root, 'target'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const transfer = (path: string, mode: 'copy' | 'move', dir = 'target') =>
  transferWorkspaceEntry({ cwd: root, path, dir, mode })

describe('file transfers', () => {
  it('copies nested binary files without modifying the original', async () => {
    await mkdir(join(root, 'source', 'nested'), { recursive: true })
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    await writeFile(join(root, 'source', 'nested', 'data.bin'), bytes)
    await transfer('source', 'copy')
    expect(await readFile(join(root, 'target/source/nested/data.bin'))).toEqual(bytes)
    expect(await readFile(join(root, 'source/nested/data.bin'))).toEqual(bytes)
  })
  it('keeps both copies, including concurrent requests and extension spelling', async () => {
    await writeFile(join(root, 'a.txt'), 'original')
    const results = await Promise.all([transfer('a.txt', 'copy'), transfer('a.txt', 'copy'), transfer('a.txt', 'copy')])
    expect(results.map(result => result.path)).toEqual(['a.txt', 'a (1).txt', 'a (2).txt'].map(name => join(root, 'target', name)))
    for (const result of results) expect(await readFile(result.path, 'utf8')).toBe('original')
  })
  it('duplicates in the same directory and permits a no-op move', async () => {
    await writeFile(join(root, 'a.txt'), 'original')
    expect((await transfer('a.txt', 'copy', '.')).path).toBe(join(root, 'a (1).txt'))
    expect((await transfer('a.txt', 'move', '.')).path).toBe(join(root, 'a.txt'))
  })
  it('moves a directory and refuses conflicting destinations without changing either file', async () => {
    await mkdir(join(root, 'source'))
    await writeFile(join(root, 'source/a.txt'), 'original')
    await transfer('source', 'move')
    await expect(readFile(join(root, 'source/a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'target/source/a.txt'), 'utf8')).toBe('original')
    await writeFile(join(root, 'a.txt'), 'from')
    await writeFile(join(root, 'target/a.txt'), 'to')
    await expect(transfer('a.txt', 'move')).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('from')
    expect(await readFile(join(root, 'target/a.txt'), 'utf8')).toBe('to')
  })
  it.each(['copy', 'move'] as const)('refuses the workspace root and descendant destinations for %s', async mode => {
    await mkdir(join(root, 'source/nested'), { recursive: true })
    await expect(transfer('.', mode)).rejects.toThrow('workspace root')
    await expect(transfer('source', mode, 'source')).rejects.toThrow('descendants')
    await expect(transfer('source', mode, 'source/nested')).rejects.toThrow('descendants')
  })
  it('rejects descendant destinations through directory links', async () => {
    await mkdir(join(root, 'source/nested'), { recursive: true })
    await symlink(join(root, 'source/nested'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(transfer('source', 'copy', 'alias')).rejects.toThrow('descendants')
  })
  it('exposes session-scoped transfers and rejects invalid modes over the JSON route', async () => {
    const routes: SidebarWebRoute[] = []
    apply({
      connection: { requestRejection: () => undefined },
      webServer: { register: (route: SidebarWebRoute) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
      sessions: { get: () => ({ header: { cwd: root } }) }, tools: { register: () => () => {} },
      effect: (effect: () => void) => effect(), inject: () => () => {}, on: () => () => {}, get: () => undefined,
    } as never, {})
    const route = routes.find(route => route.path === '/sidebar/api')!
    const invoke = async (mode: string) => {
      const body = Buffer.from(JSON.stringify({ sessionId: 's', path: 'a.txt', dir: 'target', mode }))
      let status = 200
      let output = ''
      await route.handler({ method: 'POST', url: '/sidebar/api/fs.transfer', headers: { host: '127.0.0.1:3080' },
        [Symbol.asyncIterator]: async function* () { yield body },
      } as never, { writeHead: (code: number) => { status = code }, end: (chunk: unknown) => { output += String(chunk ?? '') } } as never)
      return { status, body: JSON.parse(output) }
    }
    await writeFile(join(root, 'a.txt'), 'source')
    const valid = await invoke('copy')
    expect(valid.status).toBe(200)
    expect(valid.body.value.path).toBe(join(root, 'target/a.txt'))
    const invalid = await invoke('overwrite')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('bad-request')
  })
})
