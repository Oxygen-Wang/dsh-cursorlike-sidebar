import type { SidebarDiffRef } from './state.ts';
import type { Context } from '../context-types.ts';
export declare function DiffTab(props: {
    ctx?: Context;
    sessionId: string;
    cwd: string | undefined;
    diff: SidebarDiffRef;
}): import("react").JSX.Element;
