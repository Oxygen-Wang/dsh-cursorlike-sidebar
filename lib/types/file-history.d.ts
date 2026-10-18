import { type WorkspaceWriteInput } from './fs-operations.ts';
import type { FileActionKind, FileHistoryResult, FileHistoryState } from './file-history-types.ts';
interface Scope {
    sessionId: string;
    cwd: string;
}
export interface FileHistoryCommand {
    kind: FileActionKind;
    path: string;
    name?: string;
    dir?: string;
    group?: string;
}
/** Stored beside the workspace so recovery moves stay on its filesystem. */
export declare function fileRecoveryRoot(cwd: string): string;
export declare class FileOperationHistory {
    private readonly storageRoot?;
    private queue;
    constructor(storageRoot?: string | undefined);
    private serial;
    private root;
    private file;
    private load;
    private save;
    private summary;
    state(scope: Scope): Promise<FileHistoryState>;
    /** Atomic editor saves replace the inode; keep the SAME logical file undoable. */
    write(scope: Scope, input: WorkspaceWriteInput): Promise<{
        mtimeMs?: number;
    }>;
    execute(scope: Scope, command: FileHistoryCommand): Promise<{
        path: string;
    }>;
    replay(scope: Scope, direction: 'undo' | 'redo', expectedId?: string): Promise<FileHistoryResult>;
}
export {};
