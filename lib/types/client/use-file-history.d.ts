import { type SessionScope } from './api.ts';
import type { FileHistoryEffect, FileHistorySummary } from '../file-history-types.ts';
export declare function useFileHistory(scope: SessionScope, onEffect: (effect: FileHistoryEffect) => void, blocked?: boolean, beforeReplay?: (step: FileHistorySummary, direction: 'undo' | 'redo') => boolean): {
    busy: boolean;
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    toolbar: import("react").JSX.Element;
    feedback: import("react").JSX.Element;
};
