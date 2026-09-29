// @vitest-environment happy-dom
/**
 * The task store (#1122): the shell creates it, pages read the workspace's
 * `TaskIndex.list()` through it, and navigating between those pages opens no
 * new subscription — one live read for the app's lifetime, following the
 * viewer's workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useKeyValueStorage, useTaskStore, useViewer, type ActorDefs } from '../src/index';

const ROWS = [
    { id: 't2', objective: 'Two', status: 'active', assignee: 'a1' },
    { id: 't1', objective: 'One', status: 'done', assignee: 'a2' }
];

/** A transport answering `TaskIndex.list()`; its live channel records every subscription and counts the open ones. */
function taskIndexTransport() {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const calls: string[] = [];
    const transport: ActorTransport = {
        name: 'task-index',
        call: async (symbol) => {
            // The app's other stores (the workspace's) read too; only the TaskIndex's reads are this test's.
            if (!symbol.startsWith('TaskIndex#')) return undefined;
            calls.push(symbol);
            return ROWS;
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                if (sub.type !== 'TaskIndex') return () => undefined;
                open.set(sub, onValue);
                opened.push(`${sub.key}#${sub.method}`);
                return () => void open.delete(sub);
            }
        })
    };
    const push = (value: unknown): void => {
        for (const [sub, fn] of open) if (sub.method === 'list') fn(value);
    };
    return { transport, open: () => [...open.keys()].map((s) => `${s.key}#${s.method}`).sort(), opened, calls, push };
}

const TaskIndex = __actorRef('TaskIndex', '/_sigx/actor', [], []);
const Workspace = __actorRef('Workspace', '/_sigx/actor', [], []);

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    vi.restoreAllMocks();
});

function mount(tree: JSXElement, transport: ActorTransport, workspace: { id: string | null }, withDefs = true): () => void {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(actorsPlugin({ transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
    if (withDefs) app.defineProvide(useActorDefs, () => ({ TaskIndex, Workspace }) as unknown as ActorDefs);
    app.defineProvide(useViewer, () => () => ({
        get workspaceId() {
            return workspace.id;
        },
        pending: false
    }));
    app.defineProvide(useKeyValueStorage, () => memoryKeyValueStorage());
    app.mount(container);
    let done = false;
    const close = (): void => {
        if (done) return;
        done = true;
        app.unmount();
        container.remove();
    };
    closers.push(close);
    return close;
}

const text = (sel: string): string | undefined => document.querySelector(sel)?.textContent ?? undefined;

describe('useTaskStore (#1122)', () => {
    it('reads the TaskIndex once per app: two page mount/unmount cycles open no new subscription', async () => {
        const live = taskIndexTransport();
        const page = signal({ at: 'tasks' as 'tasks' | 'chat' | 'none' });
        const TasksPage = component(() => {
            const store = useTaskStore();
            return () => <p class="tasks">{store.rows.map((r) => r.id).join(',')} {String(store.read.loading)}</p>;
        });
        const ChatPage = component(() => {
            const read = useTaskStore().read;
            return () => <p class="chat">{(read.value ?? []).filter((r) => r.status === 'active').length}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'tasks' ? <TasksPage /> : page.at === 'chat' ? <ChatPage /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        const one = ['ws1:task-index#list'];
        expect(live.open()).toEqual(one);
        expect(text('.tasks')).toBe('t2,t1 false');

        for (const at of ['none', 'chat', 'none', 'tasks', 'none', 'chat'] as const) {
            page.at = at;
            await tick();
            expect(live.open(), `after switching to ${at}`).toEqual(one);
        }
        expect(live.opened).toEqual(one);
        expect(live.calls).toHaveLength(1);
        expect(text('.chat')).toBe('1');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A push reaches the page through the store.
        live.push([{ id: 't3', objective: 'Three', status: 'active' }, ...ROWS]);
        await tick();
        expect(text('.chat')).toBe('2');

        close();
        expect(live.open()).toEqual([]);
    });

    it('follows the viewer’s workspace', async () => {
        const live = taskIndexTransport();
        const workspace = signal({ id: 'ws1' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useTaskStore();
            return () => <p class="tasks">{store.rows.length}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.open()).toEqual(['ws1:task-index#list']);
        workspace.id = 'ws2';
        await tick();
        expect(live.open()).toEqual(['ws2:task-index#list']);
        workspace.id = null;
        await tick();
        expect(live.open()).toEqual([]);
        expect(text('.tasks')).toBe('0');
    });

    it('reads nothing and answers empty without actor definitions (mock data)', async () => {
        const live = taskIndexTransport();
        const Shell = component(() => {
            initAppStores();
            const store = useTaskStore();
            return () => <p class="tasks">{store.rows.length} {String(store.read.loading)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws1' }, false);
        await tick();
        expect(live.opened).toEqual([]);
        expect(live.calls).toEqual([]);
        expect(text('.tasks')).toBe('0 false');
    });
});
