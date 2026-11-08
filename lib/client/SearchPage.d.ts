import { type ReactNode } from 'react';
import type { SearchRequest, SearchResult, ReadRequest, ReadResult, StatusResult } from '../remote.js';
export type SearchMode = 'auto' | 'keyword' | 'title' | 'semantic';
export interface SearchFace {
    search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>;
    read(request: ReadRequest, signal: AbortSignal): Promise<ReadResult>;
    status(signal: AbortSignal): Promise<StatusResult>;
    /** Open a session in the conversation view (optionally aiming at a seq). */
    open(sessionId: string, seq?: number): void;
    t: (key: string, params?: Record<string, unknown>) => string;
}
/** Terms to highlight: the whole query plus its whitespace-separated words. */
export declare function highlightTerms(query: string): string[];
/** Wrap occurrences of `terms` (case-insensitive) in <mark>. */
export declare function highlight(text: string, terms: string[]): ReactNode[];
export declare function SearchPage(props: SearchFace): import("react").JSX.Element;
/** Sidebar row icon: magnifier over a clock hand. */
export declare function SearchIcon({ size }: {
    size?: number;
}): import("react").JSX.Element;
