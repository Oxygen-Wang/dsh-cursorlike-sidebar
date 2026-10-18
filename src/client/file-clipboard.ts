import type { SessionScope } from './api.ts'
import { isWithinWorkspace } from './paths.ts'

export type FileTransferMode = 'copy' | 'move'
interface FileClipboard { sessionId: string; cwd?: string; paths: string[]; mode: FileTransferMode }
let clipboard: FileClipboard | undefined

/** Drop nested selections: transferring a directory already includes its children. */
export function topLevelPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].filter(path => !paths.some(parent => parent !== path && isWithinWorkspace(parent, path)))
}
export function writeFileClipboard(scope: SessionScope, paths: string[], mode: FileTransferMode): void {
  clipboard = { ...scope, paths: topLevelPaths(paths), mode }
}
export function readFileClipboard(scope: SessionScope): FileClipboard | undefined {
  return clipboard?.sessionId === scope.sessionId && clipboard.cwd === scope.cwd ? clipboard : undefined
}
export function consumeFileClipboard(scope: SessionScope, moved: string): void {
  const value = readFileClipboard(scope)
  if (value?.mode === 'move') value.paths = value.paths.filter(path => path !== moved)
}
