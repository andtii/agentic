/** Chats: attributed entries, membership, addressing (CHT-01..11). */

import type { AgentId, ChatId, MachineId, MessageId, ProjectId, SessionId, TaskId } from './ids.js';
import type { SessionOptions, SessionOptionsPatch } from './session-options.js';
import type { TaskError } from './task.js';
import type { WorkdirRef } from './workdir.js';

/** The content a user or agent sends. Mirrors the shape of `@sigx/ai-agent`'s prompt parts without depending on it. */
export type PromptPart =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly mediaType: string; readonly data?: string; readonly url?: string }
    | { readonly type: 'file'; readonly mediaType: string; readonly name?: string; readonly data?: string; readonly url?: string }
    | { readonly type: 'resource'; readonly uri: string; readonly mediaType?: string };

export type Author = { readonly kind: 'user' } | { readonly kind: 'agent'; readonly agentId: AgentId; readonly sessionId?: SessionId };

export type HistoryAccess = 'all' | 'from-now';

/** The `ref` of a `request` / `request-resolved` status entry: what is asked (an approval, or an input) and the request id. */
export type RequestStatusRef = `approval:${string}` | `input:${string}`;

export function isRequestStatusRef(ref: unknown): ref is RequestStatusRef {
    return typeof ref === 'string' && /^(approval|input):.+/.test(ref);
}

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
          /**
           * Set on the note `Chat.setWorkdir` writes (#190): a member's working folder for this chat
           * changed. Whoever folds the entries copies `ref` onto the member; `null` clears it.
           */
          readonly workdir?: { readonly agentId: AgentId; readonly ref: WorkdirRef | null };
          /**
           * Set on the note `Chat.setOptions` writes (#450): a member's model or permission mode for this chat changed.
           * Whoever folds the entries applies `patch` to the member's `options` (`applySessionOptions`; `null` clears a key).
           */
          readonly options?: { readonly agentId: AgentId; readonly patch: SessionOptionsPatch };
          /**
           * Set on the note `Chat.setProject` writes (#330): the chat now belongs to this project,
           * or to none with `null`. Whoever folds the entries keeps the last one; the router reads
           * the project's folder for each member's environment unless the member has its own.
           */
          readonly project?: { readonly id: ProjectId | null };
          /**
           * Set on the note `Chat.setMachine` writes (#414): the chat now runs on this machine, or
           * on none with `null`. Whoever folds the entries keeps the last one; the activation
           * contract copies it into each task as `machineId`.
           */
          readonly machine?: { readonly id: MachineId | null };
      }
    | { readonly t: 'member'; readonly op: 'add' | 'remove'; readonly agentId: AgentId; readonly historyAccess: HistoryAccess; readonly at: number }
    | {
          readonly t: 'status';
          readonly agentId: AgentId;
          readonly kind: 'typing' | 'session-started' | 'session-ended' | 'task';
          readonly ref?: string;
          readonly at: number;
      }
    | {
          readonly t: 'status';
          readonly agentId: AgentId;
          /**
           * `request`: the session raised a request a person must answer (COL-10 / CHT-09);
           * `request-resolved`: it settled. `ref` is the same on both, so the two pair up.
           */
          readonly kind: 'request' | 'request-resolved';
          readonly ref: RequestStatusRef;
          readonly at: number;
      }
    | {
          readonly t: 'status';
          readonly agentId: AgentId;
          /**
           * `task-failed`: the task the agent was activated for could not run or ended in
           * error (OPS-04 — a named failure in the thread, never silence): `ref` is the task
           * id, `error` says why (`session-open`, `no-api-key`, `environment-offline`, …).
           * The router writes it; an interrupted turn is a `task` status, not a failure.
           */
          readonly kind: 'task-failed';
          readonly ref: TaskId;
          readonly error: TaskError;
          readonly at: number;
      }
    | { readonly t: 'coordinator'; readonly agentId: AgentId | null; readonly at: number }
    /** The chat was (re)named (#124): the title in force from this entry on. Whoever folds the entries keeps the last one. */
    | { readonly t: 'rename'; readonly title: string; readonly at: number };

export interface ChatMember {
    readonly since: number;
    /** Index of the first entry this member may read. */
    readonly historyFrom: number;
    /** The folder this agent works in for this chat (#185): copied into every task the chat activates it for. */
    readonly workdir?: WorkdirRef;
    /** Its model and permission mode for this chat (#450): copied into the task of every activation; its session takes them on its next turn. */
    readonly options?: SessionOptions;
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
          /** With `status: 'task-failed'`: why (`ref` is then the task id). */
          readonly error?: TaskError;
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

/** One agent of a chat, as a member's system prompt names it. */
export interface ChatRosterMember {
    readonly agentId: AgentId;
    readonly name: string;
    /** The agent's responsibilities (`AgentConfig.role`), when it has any. */
    readonly role?: string;
}

/**
 * Who a session's agent shares its chat with (CHT-07): the members, the
 * coordinator if the chat has one, and which member the session runs as.
 * The router reads it from the Chat and the members' configs when it opens
 * a chat-originated session; the runtime renders it into the system prompt,
 * so an agent knows the others are platform agents it reaches with
 * `delegate` / `chat_post` — not anything on the machine it runs on.
 */
export interface ChatRoster {
    readonly chatId: ChatId;
    readonly title?: string;
    /** The member the session runs as. */
    readonly self: AgentId;
    readonly coordinator?: AgentId;
    readonly members: readonly ChatRosterMember[];
    /** The project the chat belongs to (#330), named so the prompt can say where the work lives. */
    readonly project?: { readonly id: ProjectId; readonly name: string };
    /** The machine the chat runs on (#414), named so the prompt can say where the work runs. */
    readonly machine?: { readonly id: MachineId; readonly name: string };
}
