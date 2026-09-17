/**
 * `exportAll` and `deleteAll` (OPS-10; architecture §4 Workspace, §9).
 *
 * Both run as detached tasks of the Workspace actor. A task body inherits no
 * principal, so every read is made through the server-side `actor()` client
 * with the OWNER's principal attached (`asPrincipal`), exactly as an
 * in-process caller with no request does — the same `authorize` chains run
 * as for the owner at the keyboard. State access goes through `ctx.turn`.
 *
 * Export: one NDJSON file per actor kind under `{ws}/{stamp}/`, produced by
 * each actor's own `get` / `export` (never raw storage), plus `manifest.json`
 * listing what was written and what was NOT (records the index cannot type).
 * Secrets appear by name only. Pairing codes never appear.
 *
 * Delete: every child record the index and `store.list` know is purged
 * through the `WorkspaceStore` port, children first, the Workspace record
 * last (`clearState`). What is outside the platform's reach is listed in
 * `docs/retention.md`.
 */

import type { AgentId, ChatId, MemoryScope, Principal, ScheduleId, WorkspaceId } from '@agentic/core';
import { actor, type ActorTaskContext, type AnyActorDefinition } from '@sigx/actors';
import { AgentActor, agentKey } from '../agent/index.js';
import { asPrincipal } from '../auth/index.js';
import { Chat, PAGE, pageKey } from '../chat/index.js';
import { Memory, memoryActorKey } from '../memory/index.js';
import { Inbox, inboxKey } from '../notify/index.js';
import { Registry, registryKey } from '../registry/index.js';
import { defineScheduleActor } from '../schedule/index.js';
import { defineSessionActor } from '../session/index.js';
import { TaskActor } from '../task/index.js';
import type { ActorRecordRef, ArtifactSink, WorkspaceStore } from './ports.js';
import type { WorkspaceState } from './index.js';

export interface CascadeOptions {
    readonly sink?: ArtifactSink;
    readonly store?: WorkspaceStore;
    readonly now?: () => number;
}

export interface ExportReport {
    readonly prefix: string;
    /** `{ path, rows }` per file written. */
    readonly files: readonly { readonly path: string; readonly rows: number }[];
    /** Records the cascade saw but has no typed reader for. */
    readonly notExported: readonly ActorRecordRef[];
}

export interface DeleteReport {
    readonly purged: readonly ActorRecordRef[];
}

/** Hop targets resolved by TYPE on the host — the app's own instances answer (see `Registry`'s `ScheduleRefDef`). */
const ScheduleRef = defineScheduleActor({
    trigger: {
        fired() {
            throw new Error('[workspace] ScheduleRef is a hop target, never a host');
        }
    }
});
const SessionRef = defineSessionActor({ factory: () => null });

type Ctx = ActorTaskContext<WorkspaceState>;

const ownerOf = (owner: string): Principal => ({ kind: 'user', userId: owner, workspaceId: owner as WorkspaceId });

/** The memory scopes the index implies: every agent's own, plus the shared scopes any agent may read. */
function memoryScopes(agents: readonly { id: AgentId; shared: readonly string[] }[]): MemoryScope[] {
    const out = new Set<MemoryScope>();
    for (const a of agents) {
        out.add(`agent:${a.id}`);
        for (const s of a.shared) out.add((s.startsWith('shared:') ? s : `shared:${s}`) as MemoryScope);
    }
    return [...out];
}

function stamp(at: number): string {
    return new Date(at).toISOString().replace(/[:.]/g, '-');
}

export async function exportWorkspace(ctx: Ctx, options: CascadeOptions): Promise<ExportReport> {
    const { sink } = options;
    if (!sink) throw new Error('[workspace] exportAll: no ArtifactSink configured');
    const now = options.now ?? (() => Date.now());
    const snap = await ctx.turn((c) => c.snapshot());
    const ws = snap.owner as WorkspaceId;
    const as = <D extends AnyActorDefinition>(def: D, key: string) => actor(def, key).with({ context: asPrincipal(ownerOf(snap.owner)) });
    const prefix = `${ws}/${stamp(now())}`;
    const files: { path: string; rows: number }[] = [];
    const notExported: ActorRecordRef[] = [];

    const write = async (kind: string, rows: readonly unknown[]): Promise<void> => {
        const path = `${prefix}/${kind}.ndjson`;
        await sink.put(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { contentType: 'application/x-ndjson' });
        files.push({ path, rows: rows.length });
    };

    // workspace — the index and settings; pairing codes and the ops log stay out.
    const { ops: _ops, ...rest } = snap;
    void _ops;
    await write('workspace', [{ kind: 'workspace', workspace: { ...rest, machines: snap.machines.map(({ pairing: _p, ...m }) => m) } }]);

    // agents
    const agentRows: unknown[] = [];
    const agentRefs: { id: AgentId; shared: readonly string[] }[] = [];
    for (const id of snap.agents) {
        const a = as(AgentActor, agentKey(ws, id));
        const view = await a.get();
        const versions = await a.listVersions();
        agentRows.push({ kind: 'agent', agent: { ...view, versions } });
        agentRefs.push({ id: view.id, shared: view.config.memoryPolicy.shared });
    }
    await write('agents', agentRows);

    // memory — every entry of every scope the agents imply
    const memoryRows: unknown[] = [];
    for (const scope of memoryScopes(agentRefs)) {
        const m = as(Memory, memoryActorKey(ws, scope));
        let after: string | null = null;
        do {
            const page = await m.exportPage(after);
            for (const entry of page.entries) memoryRows.push({ kind: 'memory', scope, entry });
            after = page.next;
        } while (after !== null);
    }
    await write('memory', memoryRows);

    // chats — summary then every entry the owner can read, oldest first
    const chatRows: unknown[] = [];
    for (const id of snap.chats) {
        const c = as(Chat, `${ws}:chat:${id}`);
        const summary = await c.get();
        chatRows.push({ kind: 'chat', id, chat: summary });
        const entries: { seq: number; entry: unknown }[] = [];
        let cursor: number | null = null;
        for (;;) {
            const page = await c.history(cursor, 200);
            entries.push(...page.entries);
            if (page.next === null || page.entries.length === 0) break;
            cursor = page.next;
        }
        entries.sort((x, y) => x.seq - y.seq);
        for (const e of entries) chatRows.push({ kind: 'chat-entry', chatId: id, seq: e.seq, entry: e.entry });
    }
    await write('chats', chatRows);

    // schedules — an indexed id that was never created is skipped
    const scheduleRows: unknown[] = [];
    for (const id of snap.schedules) {
        try {
            scheduleRows.push({ kind: 'schedule', id, schedule: await as(ScheduleRef, `${ws}:schedule:${id}`).get() });
        } catch {
            notExported.push({ type: 'Schedule', key: `${ws}:schedule:${id}` });
        }
    }
    await write('schedules', scheduleRows);

    // inbox
    const inbox = as(Inbox, inboxKey(ws));
    const inboxRows: unknown[] = (await inbox.list()).map((n) => ({ kind: 'notification', notification: n }));
    for (const s of await inbox.subscriptions()) inboxRows.push({ kind: 'push-subscription', subscription: s });
    await write('inbox', inboxRows);

    // registry — secrets by name only
    await write('registry', await as(Registry, registryKey(ws)).exportRows());

    // what the index cannot see: tasks and sessions, when the store can list them
    if (options.store?.list) {
        const taskRows: unknown[] = [];
        const sessionRows: unknown[] = [];
        for (const ref of await options.store.list(ws)) {
            try {
                if (ref.type === TaskActor.type) {
                    taskRows.push({ kind: 'task', key: ref.key, task: await as(TaskActor, ref.key).get() });
                } else if (ref.type === SessionRef.type) {
                    const s = as(SessionRef, ref.key);
                    sessionRows.push({ kind: 'session', key: ref.key, session: await s.get(), events: await s.events() });
                } else if (!KNOWN_TYPES.has(ref.type)) {
                    notExported.push(ref);
                }
            } catch {
                notExported.push(ref);
            }
        }
        await write('tasks', taskRows);
        await write('sessions', sessionRows);
    }

    const manifest = { workspaceId: ws, exportedAt: now(), retention: snap.settings.retention, files, notExported };
    await sink.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
    return { prefix, files, notExported };
}

/** Types the export reads through the index; anything else the store lists is "present, not exported". Literals: this module and the Registry import each other. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(['Workspace', 'Agent', 'Memory', 'Chat', 'ChatPage', 'Schedule', 'Inbox', 'Registry']);

/** Every child record the index implies, children first; the root is NOT included. */
export async function childRecords(snap: WorkspaceState): Promise<ActorRecordRef[]> {
    const ws = snap.owner as WorkspaceId;
    const as = <D extends AnyActorDefinition>(def: D, key: string) => actor(def, key).with({ context: asPrincipal(ownerOf(snap.owner)) });
    const refs = new Map<string, ActorRecordRef>();
    const add = (type: string, key: string) => refs.set(`${type} ${key}`, { type, key });

    const agentRefs: { id: AgentId; shared: readonly string[] }[] = [];
    for (const id of snap.agents) {
        const key = agentKey(ws, id as AgentId);
        try {
            const view = await as(AgentActor, key).get();
            agentRefs.push({ id: view.id, shared: view.config.memoryPolicy.shared });
        } catch {
            agentRefs.push({ id: id as AgentId, shared: [] });
        }
        add(AgentActor.type, key);
    }
    for (const scope of memoryScopes(agentRefs)) add(Memory.type, memoryActorKey(ws, scope));
    for (const id of snap.chats) {
        const key = `${ws}:chat:${id as ChatId}`;
        let seq = 0;
        try {
            seq = (await as(Chat, key).get()).seq;
        } catch {
            // Unreadable chat: purge the record and page 0 anyway.
        }
        for (let page = 0; page <= Math.floor(seq / PAGE); page++) add('ChatPage', pageKey(key, page));
        add(Chat.type, key);
    }
    for (const id of snap.schedules) add('Schedule', `${ws}:schedule:${id as ScheduleId}`);
    add(Inbox.type, inboxKey(ws));
    add(Registry.type, registryKey(ws));
    return [...refs.values()];
}

export async function deleteWorkspace(ctx: Ctx, options: CascadeOptions): Promise<DeleteReport> {
    const { store } = options;
    if (!store) throw new Error('[workspace] deleteAll: no WorkspaceStore configured');
    const snap = await ctx.turn((c) => c.snapshot());
    const ws = snap.owner as WorkspaceId;
    const rootKey = ctx.key;

    const refs = new Map<string, ActorRecordRef>();
    const add = (ref: ActorRecordRef) => {
        if (!(ref.type === 'Workspace' && ref.key === rootKey)) refs.set(`${ref.type} ${ref.key}`, ref);
    };
    for (const ref of await childRecords(snap)) add(ref);
    if (store.list) for (const ref of await store.list(ws)) add(ref);

    const purged: ActorRecordRef[] = [];
    for (const ref of refs.values()) {
        await store.purge(ref);
        purged.push(ref);
    }
    // The root goes last: after this the workspace is a fresh `state(key)` and nothing is saved.
    await ctx.turn((c) => c.clearState());
    return { purged };
}
