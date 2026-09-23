/**
 * What the mock workspace's pages posted into a chat (#565): the session
 * views' "Ask about a line" has no Chat actor to post to in mock mode, so it
 * keeps the message here and the mock chat page shows it after its own —
 * enough to see the question land with its hunk. Kept for the visit.
 */
import type { PromptPart } from '@agentic/core';

export interface MockChatPost {
    readonly id: string;
    readonly parts: readonly PromptPart[];
    readonly at: number;
}

const posts = new Map<string, MockChatPost[]>();
let seq = 0;

export function postToMockChat(chatId: string, parts: readonly PromptPart[], at = Date.now()): MockChatPost {
    const post = { id: `mock_post_${++seq}`, parts, at };
    posts.set(chatId, [...(posts.get(chatId) ?? []), post]);
    return post;
}

export const mockChatPosts = (chatId: string): readonly MockChatPost[] => posts.get(chatId) ?? [];

/** Forget every post (tests). */
export function clearMockChatPosts(): void {
    posts.clear();
}
