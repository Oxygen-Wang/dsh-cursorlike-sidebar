/** Shared interaction layer for the grid and each Miller column. */
import { type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { type FsEntry } from './api.ts';
import { type FileTransferMode } from './file-clipboard.ts';
import { type UploadItem } from './upload.ts';
export interface FileBrowserActionsProps {
    sessionId: string;
    cwd: string | undefined;
    onOpenFile: (path: string) => void;
    onOpenFileNewTab?: (path: string) => void;
    onOpenFileSide?: (path: string) => void;
    onReferenceFile: (path: string, isDir: boolean) => void;
    onPathRenamed?: (oldPath: string, newPath: string) => void;
    onPathDeleted?: (path: string, isDir: boolean) => void;
    onUploadRequest?: (dir: string, items: UploadItem[]) => void;
    busy?: boolean;
    onBeforeRemove?: (paths: string[]) => boolean;
    onTransferRequest?: (dir: string, paths: string[], mode: FileTransferMode) => void;
}
export declare function useFileBrowserActions(props: FileBrowserActionsProps, dir: string | undefined, entries: readonly FsEntry[], open: (entry: FsEntry) => void, refresh: () => void, navigationColumns?: number): {
    selected: Set<string>;
    controls: import("react").JSX.Element;
    keyDown: (event: KeyboardEvent<HTMLElement>) => void;
    contextMenu: (event: MouseEvent<HTMLElement>, entry?: FsEntry) => void;
    dragOver: (event: DragEvent<HTMLElement>) => void;
    drop: (event: DragEvent<HTMLElement>, destination?: string | undefined) => void;
    rowProps: (entry: FsEntry) => {
        'data-dsh-selected': string | undefined;
        'aria-pressed': boolean;
        onClick: (event: MouseEvent<HTMLElement>) => void;
        onContextMenu: (event: MouseEvent<HTMLElement>) => void;
        onDragStart: (event: DragEvent<HTMLElement>) => void;
        onDragOver: (event: DragEvent<HTMLElement>) => void;
        onDrop: (event: DragEvent<HTMLElement>) => void;
    };
    clearSelection: () => void;
};
