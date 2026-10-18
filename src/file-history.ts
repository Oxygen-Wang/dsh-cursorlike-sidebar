/** Persistent, conflict-aware undo for explorer operations. No backup is unlinked. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createWorkspaceFile, mkdirWorkspaceEntry, renameWorkspaceEntry, transferWorkspaceEntry, writeWorkspaceText, type WorkspaceWriteInput } from './fs-operations.ts'
import { invalidateDirectoryCache } from './fs-tree.ts'
import { resolveTarget } from './path-security.ts'
import { SidebarError } from './wire.ts'
import type { FileActionKind, FileHistoryEffect, FileHistoryResult, FileHistoryState, FileHistorySummary } from './file-history-types.ts'
import { RECOVERY_DIRECTORY } from './file-history-types.ts'

interface Scope { sessionId: string; cwd: string }
interface Identity { dev: string; ino: string; birth: string }
interface Change {
  from: string
  to: string
  identity: Identity
  isDir: boolean
  /** Which endpoint is a recovery slot, rather than a user's live path. */
  recovery?: 'from' | 'to'
}
interface Step extends FileHistorySummary { group?: string; changes: Change[] }
interface Journal { version: 1; done: Step[]; undone: Step[]; retired: Step[] }
export interface FileHistoryCommand {
  kind: FileActionKind
  path: string
  name?: string
  dir?: string
  group?: string
}
const empty = (): Journal => ({ version: 1, done: [], undone: [], retired: [] })
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth

async function identity(path: string): Promise<{ id: Identity; isDir: boolean } | undefined> {
  try {
    const info = await lstat(path, { bigint: true })
    return { id: { dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs) },
      isDir: info.isDirectory() || (info.isSymbolicLink() && await stat(path).then(info => info.isDirectory()).catch(() => false)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Stored beside the workspace so recovery moves stay on its filesystem. */
export function fileRecoveryRoot(cwd: string): string {
  const canonical = process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
  return join(dirname(resolve(cwd)), RECOVERY_DIRECTORY, createHash('sha256').update(canonical).digest('hex').slice(0, 24))
}

export class FileOperationHistory {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly storageRoot?: string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }
  private root(scope: Scope): string { return this.storageRoot ?? fileRecoveryRoot(scope.cwd) }
  private file(scope: Scope): string {
    const session = createHash('sha256').update(`${scope.sessionId}\0${process.platform === 'win32' ? resolve(scope.cwd).toLowerCase() : resolve(scope.cwd)}`).digest('hex')
    return join(this.root(scope), `${session}.json`)
  }
  private async load(scope: Scope): Promise<Journal> {
    try {
      const value = JSON.parse(await readFile(this.file(scope), 'utf8')) as Journal
      if (value.version !== 1 || ![value.done, value.undone, value.retired].every(Array.isArray)) throw new Error('invalid file history')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw new SidebarError('fs-error', `cannot read file history: ${String(error)}`, 400)
    }
  }
  private async save(scope: Scope, journal: Journal): Promise<void> {
    const root = this.root(scope)
    await mkdir(root, { recursive: true, mode: 0o700 })
    // A recovery directory must not silently redirect into a different location.
    if ((await lstat(root)).isSymbolicLink()) throw new SidebarError('fs-error', 'recovery directory cannot be a symbolic link', 400)
    const file = this.file(scope)
    const temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
  }
  private summary(journal: Journal): FileHistoryState {
    const describe = ({ id, kind, paths, time }: Step): FileHistorySummary => ({ id, kind, paths, time })
    return {
      undo: journal.done.length === 0 ? null : describe(journal.done.at(-1)!),
      redo: journal.undone.length === 0 ? null : describe(journal.undone.at(-1)!),
      undoCount: journal.done.length, redoCount: journal.undone.length,
      entries: [
        ...journal.done.map(step => ({ ...describe(step), undone: false })),
        ...[...journal.undone].reverse().map(step => ({ ...describe(step), undone: true })),
      ].slice(-20).reverse(),
    }
  }
  state(scope: Scope): Promise<FileHistoryState> {
    return this.serial(async () => this.summary(await this.load(scope)))
  }

  /** Atomic editor saves replace the inode; keep the SAME logical file undoable. */
  write(scope: Scope, input: WorkspaceWriteInput): Promise<{ mtimeMs?: number }> {
    return this.serial(async () => {
      const journal = await this.load(scope)
      const path = resolveTarget(scope.cwd, input.path)
      const old = await identity(path)
      const result = await writeWorkspaceText(input)
      if (old !== undefined) {
        const changes = [...journal.done, ...journal.undone, ...journal.retired].flatMap(step => step.changes).filter(change => sameIdentity(change.identity, old.id))
        if (changes.length > 0) {
          const current = await identity(path)
          if (current !== undefined) {
            for (const change of changes) change.identity = current.id
            await this.save(scope, journal)
          }
        }
      }
      return result
    })
  }

  execute(scope: Scope, command: FileHistoryCommand): Promise<{ path: string }> {
    return this.serial(async () => {
      const journal = await this.load(scope)
      // Reserve writable recovery storage BEFORE changing a user's file.
      await this.save(scope, journal)
      const source = resolveTarget(scope.cwd, command.path)
      if (command.kind !== 'file' && command.kind !== 'folder' && (contains(source, this.root(scope)) || contains(this.root(scope), source))) {
        throw new SidebarError('fs-error', 'cannot transfer or remove file recovery storage or its parents', 400)
      }
      const recovery = join(this.root(scope), randomUUID())
      const old = command.kind === 'file' || command.kind === 'folder' ? undefined : await identity(source)
      const before = structuredClone(journal)
      const add = (change: Change, path: string): void => {
        const previous = journal.done.at(-1)
        if (command.group !== undefined && previous?.group === command.group && previous.kind === command.kind && journal.undone.length === 0) {
          previous.changes.push(change)
          previous.paths.push(path)
        } else journal.done.push({ id: randomUUID(), kind: command.kind, paths: [path], time: Date.now(), group: command.group, changes: [change] })
        // A new action replaces the redo branch, but its recovery data remains.
        journal.retired.push(...journal.undone)
        journal.undone = []
      }
      let path: string
      if (command.kind === 'delete' || command.kind === 'rename' || command.kind === 'move') {
        if (old === undefined) throw new SidebarError('fs-error', `"${source}" no longer exists`, 409)
        // Use the existing rename root guard even for reversible deletes.
        // Root identity (aliases included) is checked by the mutation helper.
        if (command.kind === 'delete') {
          await assertNotRoot(scope.cwd, source)
          add({ from: source, to: recovery, identity: old.id, isDir: old.isDir, recovery: 'to' }, source)
          await this.save(scope, journal)
          try { await relocate(source, recovery, old.id) } catch (error) { await this.save(scope, before); throw error }
          invalidateDirectoryCache(dirname(source))
          return { path: source }
        }
        // The destination is known for rename/move, so record before relocating.
        const destination = command.kind === 'rename' ? join(dirname(source), required(command.name, 'name'))
          : join(resolveTarget(scope.cwd, required(command.dir, 'dir')), basename(source))
        if (source === destination || (process.platform === 'win32' && source.toLowerCase() === destination.toLowerCase())) return { path: source }
        add({ from: source, to: destination, identity: old.id, isDir: old.isDir }, source)
        await this.save(scope, journal)
        try {
          path = command.kind === 'rename'
            ? (await renameWorkspaceEntry({ cwd: scope.cwd, path: source, name: required(command.name, 'name') })).path
            : (await transferWorkspaceEntry({ cwd: scope.cwd, path: source, dir: required(command.dir, 'dir'), mode: 'move' })).path
        } catch (error) { await this.save(scope, before); throw error }
        return { path }
      }
      if (command.kind === 'copy') path = (await transferWorkspaceEntry({ cwd: scope.cwd, path: source, dir: required(command.dir, 'dir'), mode: 'copy' })).path
      else if (command.kind === 'file') path = (await createWorkspaceFile({ cwd: scope.cwd, path: source, name: required(command.name, 'name') })).path
      else if (command.kind === 'folder') path = (await mkdirWorkspaceEntry({ cwd: scope.cwd, path: source, name: required(command.name, 'name') })).path
      else throw new SidebarError('bad-request', 'invalid file action', 400)
      const created = await identity(path)
      if (created === undefined) throw new SidebarError('fs-error', 'created entry disappeared before it could be recorded', 409)
      add({ from: recovery, to: path, identity: created.id, isDir: created.isDir, recovery: 'from' }, path)
      await this.save(scope, journal)
      return { path }
    })
  }

  replay(scope: Scope, direction: 'undo' | 'redo', expectedId?: string): Promise<FileHistoryResult> {
    return this.serial(async () => {
      const journal = await this.load(scope)
      const stack = direction === 'undo' ? journal.done : journal.undone
      const step = stack.at(-1)
      const effects: FileHistoryEffect[] = []
      if (step === undefined) return { state: this.summary(journal), effects }
      if (expectedId !== undefined && step.id !== expectedId) throw new SidebarError('fs-conflict', 'file history changed; refresh before retrying', 409)
      const changes = direction === 'undo' ? [...step.changes].reverse() : step.changes
      const moves = changes.map(change => ({ change, from: direction === 'undo' ? change.to : change.from, to: direction === 'undo' ? change.from : change.to }))
      try {
        // Check the WHOLE batch first: an obvious conflict must not half-undo it.
        for (const move of moves) await checkRelocation(move.from, move.to, move.change.identity)
        for (const { change, from, to } of moves) {
          const moved = await relocate(from, to, change.identity)
          if (moved) {
            if (change.recovery === undefined) effects.push({ type: 'move', from, path: to, isDir: change.isDir })
            else {
              const hiding = direction === 'undo' ? change.recovery === 'from' : change.recovery === 'to'
              effects.push({ type: hiding ? 'remove' : 'restore', path: hiding ? from : to, isDir: change.isDir })
            }
          }
          invalidateDirectoryCache(dirname(from)); invalidateDirectoryCache(dirname(to))
        }
        const next = structuredClone(journal)
        ;(direction === 'undo' ? next.done : next.undone).pop()
        ;(direction === 'undo' ? next.undone : next.done).push(step)
        await this.save(scope, next)
        return { state: this.summary(next), effects }
      } catch (error) {
        // Real locations remain the authority after a partial failure. Retrying
        // the same step skips already completed moves instead of losing it.
        return { state: this.summary(journal), effects, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value === '') throw new SidebarError('bad-request', `${field} is required`, 400)
  return value
}
async function checkRelocation(from: string, to: string, expected: Identity): Promise<boolean> {
  const [source, destination] = await Promise.all([identity(from), identity(to)])
  if (source === undefined && destination !== undefined && sameIdentity(destination.id, expected)) return false
  if (source === undefined || !sameIdentity(source.id, expected)) throw new SidebarError('fs-conflict', `"${from}" was removed or replaced; nothing was overwritten`, 409)
  if (destination !== undefined) throw new SidebarError('fs-conflict', `"${to}" already exists; keep both files and retry after resolving the name`, 409)
  if (!(await stat(dirname(to))).isDirectory()) throw new SidebarError('fs-conflict', `destination directory for "${to}" is missing`, 409)
  return true
}
async function relocate(from: string, to: string, expected: Identity): Promise<boolean> {
  if (!await checkRelocation(from, to, expected)) return false
  await rename(from, to)
  return true
}
async function assertNotRoot(cwd: string, path: string): Promise<void> {
  const [entry, root] = await Promise.all([identity(path), identity(resolve(cwd))])
  if (entry !== undefined && root !== undefined && sameIdentity(entry.id, root.id)) throw new SidebarError('fs-error', 'cannot remove the workspace root', 400)
}
function contains(parent: string, child: string): boolean {
  const tail = relative(parent, child)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(tail))
}
