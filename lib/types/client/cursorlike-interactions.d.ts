/** CursorLike drag references, isolated by originating DSH session. */
import type { Context } from '../context-types.ts';
import type { BetterSidebarService, SessionScope } from './service.ts';
import { type SelectionReference } from './selection-reference.ts';
export declare const CURSORLIKE_DRAG = "application/x-cursorlike-context";
export interface CursorlikeDrag {
    version: 1;
    sessionId: string;
    cwd?: string;
    paths: {
        path: string;
        directory: boolean;
    }[];
    /** Selected-text drags carry the line span with the path. */
    lineStart?: number;
    lineEnd?: number;
    text?: string;
}
/** Emit both a typed reference and an ordinary text fallback. */
export declare function writeReferenceDrag(transfer: DataTransfer, scope: SessionScope, paths: CursorlikeDrag['paths']): void;
/**
 * Emit one selected-text reference drag. `paths` carries the file so a drop
 * into the composer can mint the native `@file` chip; `lineStart/lineEnd`
 * carry the range. The text/plain fallback mirrors what the user sees.
 */
export declare function writeSelectionDrag(transfer: DataTransfer, sessionId: string, reference: SelectionReference): void;
export declare function readCursorlikeDrag(transfer: DataTransfer): CursorlikeDrag | undefined;
/** Product-owned composer and panel drop zones; never mutates a draft through DOM. */
export declare function installCursorlikeDrop(ctx: Context, service: Pick<BetterSidebarService, 'getSnapshot' | 'openFile' | 'openTab'>, doc?: Document): () => void;
