/**
 * Plan item sessions (#1078): the session a chat member runs a plan item's tasks in, kept apart from the chat's own
 * session. Item tasks run in the item's worktree (#1073), so the chat's binding (`ChatSummary.sessions[agentId]`)
 * cannot serve both: the router records each item's session in its state, and a task with no item never closes a
 * session recorded here (it reuses one only when placed in the same folder). Pure helpers over `RoutingState`.
 */

import type { AgentId, ChatId, ProjectId, SessionId } from '@agentic/core';
import type { ItemSession, RoutingState } from './state.js';

/** The key of an item's session: one per chat, member, project and plan item. */
export function itemSessionKey(chatId: ChatId, agentId: AgentId, projectId: ProjectId | undefined, planItem: number): string {
    return `${chatId}|${agentId}|${projectId ?? ''}|${planItem}`;
}

/** Whether `sessionId` is a plan item's session, which a task with no item never ends. */
export function isItemSession(state: RoutingState, sessionId: SessionId): boolean {
    return Object.values(state.itemSessions ?? {}).some((s) => s.sessionId === sessionId);
}

/** Record `session` as its item's, replacing what the key held. */
export function recordItemSession(state: RoutingState, session: ItemSession): void {
    (state.itemSessions ??= {})[itemSessionKey(session.chatId, session.agentId, session.projectId, session.planItem)] = session;
}

/** Forget every record of `sessionId` (ended, or replaced by a fresh one). */
export function forgetItemSession(state: RoutingState, sessionId: SessionId): void {
    const records = state.itemSessions;
    if (!records) return;
    for (const [key, s] of Object.entries(records)) if (s.sessionId === sessionId) delete records[key];
}

/** The item sessions of `projectId`'s items `items`, in every chat: what closes once the items are done or dropped (#1081). A
 * session the chat's binding still names may be shared with tasks with no item (an item run without its own worktree). */
export function itemSessionsOf(state: RoutingState, projectId: ProjectId, items: readonly number[]): ItemSession[] {
    const wanted = new Set(items);
    return Object.values(state.itemSessions ?? {}).filter((s) => s.projectId === projectId && wanted.has(s.planItem));
}
