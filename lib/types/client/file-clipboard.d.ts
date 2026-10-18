import type { SessionScope } from './api.ts';
export type FileTransferMode = 'copy' | 'move';
interface FileClipboard {
    sessionId: string;
    cwd?: string;
    paths: string[];
    mode: FileTransferMode;
}
/** Drop nested selections: transferring a directory already includes its children. */
export declare function topLevelPaths(paths: readonly string[]): string[];
export declare function writeFileClipboard(scope: SessionScope, paths: string[], mode: FileTransferMode): void;
export declare function readFileClipboard(scope: SessionScope): FileClipboard | undefined;
export declare function consumeFileClipboard(scope: SessionScope, moved: string): void;
export {};
