/**
 * The project Chats page's view of the task index (#804): every chat's root tasks and whether an agent works its
 * tree, in ONE pass over `TaskIndex.list()` — the same answers `chatTasks(…, Infinity)` (roots) and `workingAgents`
 * give per chat, without rebuilding the tree index once per row.
 */
import { isTerminal } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';

/** What a chat's row reads of its tasks. */
export interface ChatTaskSummary {
    /** The chat's root tasks, in the mini-tree's order: a chain that is still running first, newest first within that. */
    readonly roots: readonly string[];
    /** A task of the chat's tree is in flight: running, or waiting on a child it delegated. */
    readonly working: boolean;
}

const NONE: ChatTaskSummary = { roots: [], working: false };

/** A task in flight (as `workingAgents` reads it): running, or waiting on a child it delegated. */
const inFlight = (r: TaskIndexRow): boolean => r.status === 'active' || (r.status === 'waiting' && r.wait?.kind === 'child');

/** Every chat's root tasks and working flag, keyed by chat id; `summaryOf` reads a chat with no tasks as empty. */
export function chatTaskSummaries(rows: readonly TaskIndexRow[]): Map<string, ChatTaskSummary> {
    const byId = new Map<string, TaskIndexRow>(rows.map((r) => [r.id, r]));
    const children = new Map<string, TaskIndexRow[]>();
    for (const r of rows) {
        if (r.parentId === undefined) continue;
        const list = children.get(r.parentId);
        if (list) list.push(r);
        else children.set(r.parentId, [r]);
    }
    // The chat a row's chain of parents ends at (a root's own `chatId`); null when the chain breaks or loops.
    const chatOf = new Map<string, string | null>();
    const resolveChat = (r: TaskIndexRow): string | null => {
        const known = chatOf.get(r.id);
        if (known !== undefined) return known;
        chatOf.set(r.id, null); // a cycle, however unlikely, ends here
        const parent = r.parentId === undefined ? undefined : byId.get(r.parentId);
        const chat = r.parentId === undefined ? (r.chatId ?? null) : parent !== undefined ? resolveChat(parent) : null;
        chatOf.set(r.id, chat);
        return chat;
    };
    const runningOf = new Map<string, boolean>();
    const running = (r: TaskIndexRow): boolean => {
        const known = runningOf.get(r.id);
        if (known !== undefined) return known;
        runningOf.set(r.id, false);
        const yes = !isTerminal(r.status) || (children.get(r.id) ?? []).some(running);
        runningOf.set(r.id, yes);
        return yes;
    };
    const roots = new Map<string, TaskIndexRow[]>();
    const working = new Set<string>();
    for (const r of rows) {
        const chat = resolveChat(r);
        if (chat === null) continue;
        if (inFlight(r)) working.add(chat);
        if (r.parentId !== undefined) continue;
        const list = roots.get(chat);
        if (list) list.push(r);
        else roots.set(chat, [r]);
    }
    const out = new Map<string, ChatTaskSummary>();
    for (const [chat, list] of roots) {
        const ordered = list.sort((a, b) => Number(running(b)) - Number(running(a)) || b.createdAt - a.createdAt).map((r) => r.id);
        out.set(chat, { roots: ordered, working: working.has(chat) });
    }
    return out;
}

/** One chat's summary out of `chatTaskSummaries`: no roots and not working when the index names none of its tasks. */
export const summaryOf = (summaries: ReadonlyMap<string, ChatTaskSummary>, chatId: string): ChatTaskSummary => summaries.get(chatId) ?? NONE;
