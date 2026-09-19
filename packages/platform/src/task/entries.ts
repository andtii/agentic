/**
 * The append-log reducer: fold one `TaskEntry` into the state, in place. A pure
 * function of (state, entry) — it runs once at append and again on every
 * activation that replays the log, so it must never consult the clock or
 * anything outside its arguments.
 */

import { ZERO_USAGE, addUsage, isTerminal, type AgentId, type TaskId, type WorkspaceId } from '@agentic/core';
import { parseTaskKey } from './key.js';
import type { TaskEntry, TaskState } from './types.js';

/** The fresh state of a key nobody has `create`d yet. */
export function initialTaskState(key: string): TaskState {
    const { workspaceId, id } = parseTaskKey(key);
    return emptyState(workspaceId, id);
}

function emptyState(workspaceId: WorkspaceId, id: TaskId): TaskState {
    return {
        created: false,
        id,
        workspaceId,
        objective: '',
        origin: { kind: 'external', clientId: '' },
        assignee: '' as AgentId,
        context: [],
        constraints: {},
        owner: '' as AgentId,
        depth: 0,
        configVersion: 0,
        status: 'queued',
        sessionStopped: true,
        children: [],
        live: {},
        notStopped: [],
        usage: ZERO_USAGE,
        costUsd: 0,
        transitions: []
    };
}

export function applyTaskEntry(state: TaskState, entry: unknown): void {
    const e = entry as TaskEntry;
    switch (e.t) {
        case 'created': {
            const c = e.contract;
            state.created = true;
            state.objective = c.objective;
            state.origin = c.origin;
            state.assignee = c.assignee;
            state.context = [...c.context];
            state.constraints = { ...c.constraints };
            if (c.expected !== undefined) state.expected = c.expected;
            if (c.environmentId !== undefined) state.environmentId = c.environmentId;
            if (c.workdir !== undefined) state.workdir = c.workdir;
            if (c.resumeFrom !== undefined) state.resumeFrom = c.resumeFrom;
            state.owner = e.owner;
            state.depth = e.depth;
            if (e.parentId !== undefined) state.parentId = e.parentId;
            state.configVersion = e.configVersion;
            return;
        }
        case 'transition': {
            state.status = e.to;
            state.transitions.push({
                from: e.from,
                to: e.to,
                at: e.at,
                by: e.by,
                why: e.why,
                ...(e.wait ? { wait: e.wait } : {})
            });
            if (e.to === 'waiting' && e.wait) state.wait = e.wait;
            else delete state.wait;
            if (e.sessionId !== undefined) {
                state.sessionId = e.sessionId;
                state.sessionStopped = false;
            }
            if (e.to === 'active' && state.startedAt === undefined) state.startedAt = e.at;
            if (e.result) state.result = e.result;
            if (e.error) state.error = e.error;
            // Completion and failure end the running work; only a cancel has to wait for the driver's word.
            if (e.to === 'completed' || e.to === 'failed') state.sessionStopped = true;
            return;
        }
        case 'wait':
            state.wait = e.wait;
            return;
        case 'child':
            if (!state.children.includes(e.id)) state.children.push(e.id);
            state.live[e.id] = { ...e.constraints };
            return;
        case 'child-settled':
            if (isTerminal(e.status)) delete state.live[e.id];
            return;
        case 'cancel':
            state.cancel = { requestedAt: e.at, by: e.by, stopped: false, deadline: e.deadline, settled: false };
            return;
        case 'cancel-settled':
            if (state.cancel) {
                state.cancel.stopped = e.stopped;
                state.cancel.settled = true;
            }
            state.notStopped = [...e.notStopped];
            return;
        case 'child-stopped': {
            const unstopped = new Set(state.notStopped);
            // A late acknowledgement rewrites what we know about that subtree.
            unstopped.delete(e.id);
            for (const id of e.notStopped) unstopped.add(id);
            if (!e.stopped && e.notStopped.length === 0) unstopped.add(e.id);
            state.notStopped = [...unstopped];
            if (state.cancel?.settled) state.cancel.stopped = state.notStopped.length === 0;
            return;
        }
        case 'session-stopped':
            state.sessionStopped = true;
            if (state.cancel?.settled) {
                state.notStopped = state.notStopped.filter((id) => id !== state.id);
                state.cancel.stopped = state.notStopped.length === 0;
            }
            return;
        case 'usage':
            state.usage = addUsage(state.usage, e.usage);
            state.costUsd += e.costUsd;
            return;
    }
}
