/** Browser-safe contracts for reversible explorer mutations. */
export declare const RECOVERY_DIRECTORY = ".dsh-cursorlike-recovery";
export type FileActionKind = 'rename' | 'move' | 'copy' | 'file' | 'folder' | 'delete';
export interface FileHistorySummary {
    id: string;
    kind: FileActionKind;
    paths: string[];
    time: number;
}
export interface FileHistoryState {
    undo: FileHistorySummary | null;
    redo: FileHistorySummary | null;
    undoCount: number;
    redoCount: number;
    entries: (FileHistorySummary & {
        undone: boolean;
    })[];
}
export type FileHistoryEffect = {
    type: 'move';
    from: string;
    path: string;
    isDir: boolean;
} | {
    type: 'remove' | 'restore';
    path: string;
    isDir: boolean;
};
export interface FileHistoryResult {
    state: FileHistoryState;
    effects: FileHistoryEffect[];
    /** Partial replay stays retryable; completed effects must still reach tabs. */
    error?: string;
}
