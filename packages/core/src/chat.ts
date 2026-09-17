/** Chats: attributed entries, membership, addressing (CHT-01..11). */

import type { AgentId, MessageId, SessionId, TaskId } from './ids.js';

/** The content a user or agent sends. Mirrors the shape of `@sigx/ai-agent`'s prompt parts without depending on it. */
export type PromptPart =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly mediaType: string; readonly data?: string; readonly url?: string }
    | { readonly type: 'file'; readonly mediaType: string; readonly name?: string; readonly data?: string; readonly url?: string }
    | { readonly type: 'resource'; readonly uri: string; readonly mediaType?: string };

export type Author = { readonly kind: 'user' } | { readonly kind: 'agent'; readonly agentId: AgentId; readonly sessionId?: SessionId };

export type HistoryAccess = 'all' | 'from-now';

export type ChatEntry =
    | {
          readonly t: 'msg';
          readonly id: MessageId;
          readonly author: Author;
          readonly parts: readonly PromptPart[];
          readonly at: number;
          readonly mentions: readonly AgentId[];
          readonly replyTo?: MessageId;
          readonly sessionId?: SessionId;
          readonly taskId?: TaskId;
      }
    | { readonly t: 'member'; readonly op: 'add' | 'remove'; readonly agentId: AgentId; readonly historyAccess: HistoryAccess; readonly at: number }
    | {
          readonly t: 'status';
          readonly agentId: AgentId;
          /**
           * `request`: the session raised a request a person must answer (`ref` is
           * `approval:{requestId}` or `input:{requestId}`, COL-10 / CHT-09);
           * `request-resolved`: it settled (`ref` is the same, so the two pair up).
           */
          readonly kind: 'typing' | 'session-started' | 'session-ended' | 'task' | 'request' | 'request-resolved';
          readonly ref?: string;
          readonly at: number;
      }
    | { readonly t: 'coordinator'; readonly agentId: AgentId | null; readonly at: number };

export interface ChatMember {
    readonly since: number;
    /** Index of the first entry this member may read. */
    readonly historyFrom: number;
}

/** Result of posting: who the message activates (CHT-06). */
export interface PostResult {
    readonly messageId: MessageId;
    readonly activated: readonly AgentId[];
}

/**
 * The activation rule (architecture §6): mentioned members; else the
 * coordinator; else the sole agent member; else nobody.
 */
export function resolveActivation(mentions: readonly AgentId[], members: readonly AgentId[], coordinator: AgentId | null): readonly AgentId[] {
    const hit = mentions.filter((m) => members.includes(m));
    if (hit.length) return hit;
    if (coordinator && members.includes(coordinator)) return [coordinator];
    return members.length === 1 ? [members[0]!] : [];
}

/**
 * Topic a Session publishes on for the chat it belongs to, keyed by the chat's
 * actor key (`topic(SESSION_EVENTS_TOPIC, chatKey)`); the Chat actor subscribes
 * and folds each event into an entry (architecture §6, CHT-11).
 */
export const SESSION_EVENTS_TOPIC = 'session-events';

/**
 * What a Session tells its chat: status changes and FINAL assistant messages.
 * Streaming deltas never travel this way — the UI tails the Session directly.
 */
export type SessionEvent =
    | {
          readonly kind: 'status';
          readonly agentId: AgentId;
          readonly sessionId: SessionId;
          readonly status: Extract<ChatEntry, { t: 'status' }>['kind'];
          readonly ref?: string;
          readonly at: number;
      }
    | {
          readonly kind: 'message';
          readonly agentId: AgentId;
          readonly sessionId: SessionId;
          readonly taskId?: TaskId;
          readonly parts: readonly PromptPart[];
          readonly mentions?: readonly AgentId[];
          readonly at: number;
      };
