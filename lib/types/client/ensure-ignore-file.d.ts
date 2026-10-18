import { type SessionScope } from './api.ts';
/** Create only on a missing-file error; never overwrite existing rules. */
export declare function ensureIgnoreFile(scope: SessionScope): Promise<{
    content: string;
    mtimeMs?: number;
}>;
