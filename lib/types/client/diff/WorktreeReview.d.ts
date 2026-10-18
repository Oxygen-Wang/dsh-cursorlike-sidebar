import { type ReactNode } from 'react';
import type { Context } from '../../context-types.ts';
import { type SessionScope } from '../api.ts';
import type { SidebarDiffRef } from '../state.ts';
/**
 * Worktree writes use the same guarded, undoable line review as session
 * edits. The diff itself is a lazy surface (opening it must not read the
 * document), so the review loads only when the reader asks for it: the
 * fallback diff renders first, with a "review changes" action above it.
 */
export declare function WorktreeReview({ ctx, scope, diff, fallback, auto }: {
    ctx: Context;
    scope: SessionScope;
    diff: Extract<SidebarDiffRef, {
        kind: 'worktree';
    }>;
    fallback: ReactNode;
    /** The dedicated diff tab opens to review; the bottom preview stays lazy. */
    auto?: boolean;
}): import("react").JSX.Element;
