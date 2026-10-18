import type { BetterSidebarService } from './service.ts';
import { type FileBrowserActionsProps } from './file-browser-actions.tsx';
import { type FileTreeSort } from './file-tree-sort.ts';
export declare function FileColumns(props: FileBrowserActionsProps & {
    exclude?: readonly string[];
    visible?: boolean;
    service?: BetterSidebarService;
    refreshTick?: number;
    sort?: FileTreeSort;
}): import("react").JSX.Element | null;
