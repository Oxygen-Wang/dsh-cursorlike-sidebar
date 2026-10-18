import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileOperationHistory } from '../src/file-history.ts'
import { listDirectory } from '../src/fs-tree.ts'
import { searchFilesPlain } from '../src/fs-search.ts'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

let root: string
let cwd: string
let storage: string
let history: FileOperationHistory
let scope: { sessionId: string; cwd: string }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursorlike-history-'))
  cwd = join(root, 'workspace'); storage = join(root, 'recovery')
  await mkdir(cwd)
  history = new FileOperationHistory(storage)
  scope = { sessionId: 's', cwd }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const text = (path: string) => readFile(join(cwd, path), 'utf8')
const undo = async () => history.replay(scope, 'undo', (await history.state(scope)).undo?.id)
const redo = async () => history.replay(scope, 'redo', (await history.state(scope)).redo?.id)

describe('persistent reversible file actions', () => {
  it('restores a deleted directory and its binary content, then can delete it again', async () => {
    await mkdir(join(cwd, 'dir'))
    const bytes = Buffer.from([0, 255, 13, 10, 128])
    await writeFile(join(cwd, 'dir/data.bin'), bytes)
    await history.execute(scope, { kind: 'delete', path: 'dir' })
    await expect(readdir(join(cwd, 'dir'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await undo()).effects).toEqual([{ type: 'restore', path: join(cwd, 'dir'), isDir: true }])
    expect(await readFile(join(cwd, 'dir/data.bin'))).toEqual(bytes)
    expect((await redo()).effects).toEqual([{ type: 'remove', path: join(cwd, 'dir'), isDir: true }])
    await undo()
    expect(await readFile(join(cwd, 'dir/data.bin'))).toEqual(bytes)
  })
  it('undoes a copy without discarding later edits and redoes the same content', async () => {
    await writeFile(join(cwd, 'a.txt'), 'original')
    const copy = await history.execute(scope, { kind: 'copy', path: 'a.txt', dir: '.' })
    await history.write(scope, { cwd, path: copy.path, content: 'edited copy' })
    expect((await undo()).error).toBeUndefined()
    await expect(readFile(copy.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(cwd, 'a.txt'), 'source changed')
    expect((await redo()).error).toBeUndefined()
    expect(await readFile(copy.path, 'utf8')).toBe('edited copy')
    expect(await text('a.txt')).toBe('source changed')
  })
  it.each(['file', 'folder'] as const)('undoes and redoes new %s while preserving its content', async kind => {
    await history.execute(scope, { kind, path: '.', name: 'created' })
    const path = kind === 'file' ? 'created' : 'created/later.txt'
    await writeFile(join(cwd, path), 'later content')
    await undo()
    await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' })
    await redo()
    expect(await text(path)).toBe('later content')
  })
  it('reverses rename and move in order, following atomic saves across both steps', async () => {
    await writeFile(join(cwd, 'a.txt'), 'data')
    await mkdir(join(cwd, 'dest'))
    await history.execute(scope, { kind: 'rename', path: 'a.txt', name: 'b.txt' })
    await history.execute(scope, { kind: 'move', path: 'b.txt', dir: 'dest' })
    await history.write(scope, { cwd, path: 'dest/b.txt', content: 'new data' })
    const moved = await undo()
    expect(moved.effects[0]).toMatchObject({ type: 'move', from: join(cwd, 'dest/b.txt'), path: join(cwd, 'b.txt') })
    await undo()
    expect(await text('a.txt')).toBe('new data')
    await redo(); await redo()
    expect(await text('dest/b.txt')).toBe('new data')
  })
  it('keeps conflicting files intact and retains the step for retry', async () => {
    await writeFile(join(cwd, 'a.txt'), 'original')
    await history.execute(scope, { kind: 'delete', path: 'a.txt' })
    await writeFile(join(cwd, 'a.txt'), 'new occupant')
    const conflict = await undo()
    expect(conflict.error).toContain('already exists')
    expect(conflict.state.undoCount).toBe(1)
    expect(await text('a.txt')).toBe('new occupant')
    await rename(join(cwd, 'a.txt'), join(cwd, 'keep.txt'))
    expect((await undo()).error).toBeUndefined()
    expect(await text('a.txt')).toBe('original')
    expect(await text('keep.txt')).toBe('new occupant')
  })
  it('rejects undo when the source was replaced by a different entry', async () => {
    await history.execute(scope, { kind: 'file', path: '.', name: 'created.txt' })
    await rename(join(cwd, 'created.txt'), join(cwd, 'saved-original.txt'))
    await writeFile(join(cwd, 'created.txt'), 'replacement')
    const result = await undo()
    expect(result.error).toContain('replaced')
    expect(await text('created.txt')).toBe('replacement')
    expect(result.state.undoCount).toBe(1)
  })
  it('undoes a whole batch as one step and preflights every name before changing anything', async () => {
    await writeFile(join(cwd, 'a'), 'A'); await writeFile(join(cwd, 'b'), 'B')
    await history.execute(scope, { kind: 'delete', path: 'a', group: 'batch' })
    await history.execute(scope, { kind: 'delete', path: 'b', group: 'batch' })
    expect((await history.state(scope)).undoCount).toBe(1)
    await writeFile(join(cwd, 'a'), 'occupied')
    expect((await undo()).error).toContain('already exists')
    await expect(text('b')).rejects.toMatchObject({ code: 'ENOENT' })
    await rename(join(cwd, 'a'), join(cwd, 'keep'))
    await undo()
    expect(await text('a')).toBe('A'); expect(await text('b')).toBe('B')
    await redo()
    expect(await readdir(cwd)).toEqual(['keep'])
  })
  it('loads undo and redo from disk after recreating the host service', async () => {
    await writeFile(join(cwd, 'a.txt'), 'data')
    await history.execute(scope, { kind: 'delete', path: 'a.txt' })
    history = new FileOperationHistory(storage)
    await undo()
    history = new FileOperationHistory(storage)
    await redo()
    history = new FileOperationHistory(storage)
    await undo()
    expect(await text('a.txt')).toBe('data')
  })
  it('keeps the successful prefix of a failed batch undoable as one step', async () => {
    await writeFile(join(cwd, 'a'), 'A')
    await history.execute(scope, { kind: 'delete', path: 'a', group: 'partial' })
    await expect(history.execute(scope, { kind: 'delete', path: 'missing', group: 'partial' })).rejects.toThrow('no longer exists')
    expect((await history.state(scope)).undoCount).toBe(1)
    await undo()
    expect(await text('a')).toBe('A')
  })
  it('isolates sessions and workspaces, and refuses a stale undo target', async () => {
    await history.execute(scope, { kind: 'file', path: '.', name: 'a' })
    const first = (await history.state(scope)).undo!.id
    await history.execute(scope, { kind: 'file', path: '.', name: 'b' })
    await expect(history.replay(scope, 'undo', first)).rejects.toMatchObject({ code: 'fs-conflict' })
    expect((await history.state({ ...scope, sessionId: 'other' })).undoCount).toBe(0)
    expect((await history.state({ ...scope, cwd: root })).undoCount).toBe(0)
    expect(await readdir(cwd)).toEqual(['a', 'b'])
  })
  it('replaces the redo branch only after a successful new action; backups remain', async () => {
    await history.execute(scope, { kind: 'file', path: '.', name: 'a' })
    await writeFile(join(cwd, 'a'), 'precious')
    await undo()
    await writeFile(join(cwd, 'taken'), 'keep')
    await expect(history.execute(scope, { kind: 'file', path: '.', name: 'taken' })).rejects.toThrow('already exists')
    expect((await history.state(scope)).redoCount).toBe(1)
    await history.execute(scope, { kind: 'file', path: '.', name: 'b' })
    expect((await history.state(scope)).redoCount).toBe(0)
    const contents = await Promise.all((await readdir(storage)).filter(name => !name.endsWith('.json')).map(name => readFile(join(storage, name), 'utf8')))
    expect(contents).toContain('precious')
  })
  it('refuses the workspace root and preserves the previous history after a failed rename', async () => {
    await history.execute(scope, { kind: 'file', path: '.', name: 'a' })
    await expect(history.execute(scope, { kind: 'delete', path: '.' })).rejects.toThrow('workspace root')
    await writeFile(join(cwd, 'taken'), 'keep')
    await expect(history.execute(scope, { kind: 'rename', path: 'a', name: 'taken' })).rejects.toThrow('already exists')
    expect((await history.state(scope)).undoCount).toBe(1)
    expect(await text('taken')).toBe('keep')
  })
  it('recovers a directory link as a link and leaves its target alone', async () => {
    const target = join(root, 'target')
    await mkdir(target); await writeFile(join(target, 'keep'), 'target')
    await symlink(target, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await history.execute(scope, { kind: 'delete', path: 'link' })
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('target')
    await undo()
    expect(await text('link/keep')).toBe('target')
  })
  it('keeps recovery storage out of the explorer and recursive file search', async () => {
    const project = join(root, 'projects/workspace')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'file.txt'), 'data')
    const local = new FileOperationHistory()
    await local.execute({ sessionId: 'local', cwd: project }, { kind: 'delete', path: 'file.txt' })
    const listing = await listDirectory(join(root, 'projects'))
    expect(listing.entries.map(entry => entry.name)).toEqual(['workspace'])
    const search = await searchFilesPlain(join(root, 'projects'), 'recovery')
    expect(search.matches).toEqual([])
  })
  it('exposes recoverable delete and expected-step undo through the session API', async () => {
    const routes: SidebarWebRoute[] = []
    apply({
      connection: { requestRejection: () => undefined },
      webServer: { register: (route: SidebarWebRoute) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
      sessions: { get: () => ({ header: { cwd } }) }, tools: { register: () => () => {} },
      effect: (effect: () => void) => effect(), inject: () => () => {}, on: () => () => {}, get: () => undefined,
    } as never, {})
    const route = routes.find(route => route.path === '/sidebar/api')!
    const invoke = async (method: string, payload: Record<string, unknown> = {}) => {
      const body = Buffer.from(JSON.stringify({ sessionId: 'route-session', ...payload }))
      let status = 200; let output = ''
      await route.handler({ method: 'POST', url: `/sidebar/api/${method}`, headers: { host: '127.0.0.1:3080' },
        [Symbol.asyncIterator]: async function* () { yield body },
      } as never, { writeHead: (code: number) => { status = code }, end: (chunk: unknown) => { output += String(chunk ?? '') } } as never)
      return { status, body: JSON.parse(output) }
    }
    await writeFile(join(cwd, 'route.txt'), 'recover me')
    expect((await invoke('fs.remove', { path: 'route.txt' })).status).toBe(200)
    const state = (await invoke('fs.history')).body.value
    expect(state.undo.kind).toBe('delete')
    expect((await invoke('fs.undo', { expectedId: 'old-window' })).status).toBe(409)
    const result = await invoke('fs.undo', { expectedId: state.undo.id })
    expect(result.body.value.effects[0].type).toBe('restore')
    expect(await text('route.txt')).toBe('recover me')
    expect((await invoke('fs.redo', { expectedId: state.undo.id })).body.value.effects[0].type).toBe('remove')
  })
})
