import type { BetterSidebarService } from './service.ts';
import { type FileBrowserActionsProps } from './file-browser-actions.tsx';
import { type FileTreeSort } from './file-tree-sort.ts';
export declare function FileGrid(props: FileBrowserActionsProps & {
    sessionId: string;
    cwd: string | undefined;
    exclude?: readonly string[];
    visible?: boolean;
    service?: BetterSidebarService;
    /** Icon/thumbnail size; Ctrl+wheel drives it. */
    iconSize: number;
    onIconSizeChange: (next: number) => void;
    onOpenFile: (path: string) => void;
    onOpenFileNewTab?: (path: string) => void;
    onOpenFileSide?: (path: string) => void;
    onReferenceFile: (path: string, isDir: boolean) => void;
    refreshTick?: number;
    sort?: FileTreeSort;
}): import("react").JSX.Element;
