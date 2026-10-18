import type { BetterSidebarService } from './service.ts';
export declare function FileColumns(props: {
    sessionId: string;
    cwd: string | undefined;
    exclude?: readonly string[];
    visible?: boolean;
    service?: BetterSidebarService;
    onOpenFile: (path: string) => void;
    onOpenFileNewTab?: (path: string) => void;
    onOpenFileSide?: (path: string) => void;
    onReferenceFile: (path: string, isDir: boolean) => void;
}): import("react").JSX.Element | null;
