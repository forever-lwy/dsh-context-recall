import type { Context } from '@deepseek-ai/cordis';
export interface LocateTarget {
    turn: number;
    text?: string;
}
/**
 * Bring a message into view in the open conversation: jump with the host's
 * own turn navigation (which pages history in as needed), then highlight the
 * message itself. Best effort; gives up quietly.
 */
export declare function locateInConversation(target: LocateTarget, previousFlow: Element | null): Promise<boolean>;
/**
 * Leave the search page and open `sessionId` in the conversation view; when a
 * message is given, locate it there.
 */
export declare function openSession(ctx: Context, sessionId: string, locate?: () => Promise<LocateTarget | null>): void;
