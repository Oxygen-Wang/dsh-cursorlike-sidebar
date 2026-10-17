/** CursorLike drag references, isolated by originating DSH session. */
import type { Context } from '../context-types.ts';
import type { BetterSidebarService, SessionScope } from './service.ts';
export declare const CURSORLIKE_DRAG = "application/x-cursorlike-context";
export interface CursorlikeDrag {
    version: 1;
    sessionId: string;
    cwd?: string;
    paths: {
        path: string;
        directory: boolean;
    }[];
    text?: string;
}
/** Emit both a typed reference and an ordinary text fallback. */
export declare function writeReferenceDrag(transfer: DataTransfer, scope: SessionScope, paths: CursorlikeDrag['paths']): void;
/** Keep the ordinary selected text intact for drags inside the editor itself. */
export declare function writeSelectionDrag(transfer: DataTransfer, sessionId: string, text: string): void;
export declare function readCursorlikeDrag(transfer: DataTransfer): CursorlikeDrag | undefined;
/** Product-owned composer and panel drop zones; never mutates a draft through DOM. */
export declare function installCursorlikeDrop(ctx: Context, service: Pick<BetterSidebarService, 'getSnapshot' | 'openFile' | 'openTab'>, doc?: Document): () => void;
