// @vitest-environment happy-dom
/**
 * The workspace store (#1118): the shell creates it, pages read the Workspace
 * index through it, and navigating between those pages opens no new
 * subscription — one live read each of `get`, `projects`, `projectSummaries`
 * and `listMachines` for the app's lifetime, following the viewer's workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useKeyValueStorage, useViewer, useWorkspaceStore, type ActorDefs } from '../src/index';

const METHODS = ['get', 'projects', 'projectSummaries', 'listMachines'] as const;

/** What the Workspace answers, per method. */
function answers(zone: string) {
    return {
        get: { settings: { timeZone: zone }, machines: [{ id: 'm1', name: 'Desk' }], lastProjectId: 'p1', agents: [], chats: [], schedules: [] },
        projects: [{ id: 'p1', name: 'One' }],
        projectSummaries: { projects: [{ id: 'p1', chats: 2 }], unassigned: 0 },
        listMachines: [{ id: 'm1', name: 'Desk', status: 'paired' }]
    } as Record<(typeof METHODS)[number], unknown>;
}

/** A transport answering the Workspace's reads; its live channel records every subscription and counts the open ones. */
function workspaceTransport() {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const calls: string[] = [];
    const transport: ActorTransport = {
        name: 'workspace',
        call: async (symbol) => {
            // `symbol` is `Type#method`; the args are the key and the method's own.
            const method = symbol.split('#')[1] as (typeof METHODS)[number];
            calls.push(method);
            return answers('Europe/Stockholm')[method];
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                open.set(sub, onValue);
                opened.push(`${sub.key}#${sub.method}`);
                return () => void open.delete(sub);
            }
        })
    };
    const push = (method: string, value: unknown): void => {
        for (const [sub, fn] of open) if (sub.method === method) fn(value);
    };
    return { transport, open: () => [...open.keys()].map((s) => `${s.key}#${s.method}`).sort(), opened, calls, push };
}

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
    if (withDefs) app.defineProvide(useActorDefs, () => ({ Workspace }) as unknown as ActorDefs);
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

describe('useWorkspaceStore (#1118)', () => {
    it('reads the Workspace index once per app: two page mount/unmount cycles open no new subscription', async () => {
        const live = workspaceTransport();
        const page = signal({ at: 'zone' as 'zone' | 'projects' | 'none' });
        const ZonePage = component(() => {
            const store = useWorkspaceStore();
            return () => <p class="zone">{store.zone} {store.machineNames.get('m1')}</p>;
        });
        const ProjectsPage = component(() => {
            const store = useWorkspaceStore();
            return () => <p class="projects">{store.projects.map((p) => p.id).join(',')} {store.lastProjectId} {String(store.projectSummaries?.projects.length)} {String(store.machines?.length)}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'zone' ? <ZonePage /> : page.at === 'projects' ? <ProjectsPage /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        const all = METHODS.map((m) => `ws:ws1#${m}`).sort();
        expect(live.open()).toEqual(all);
        expect(text('.zone')).toBe('Europe/Stockholm Desk');

        for (const at of ['none', 'projects', 'none', 'zone', 'none', 'projects'] as const) {
            page.at = at;
            await tick();
            expect(live.open(), `after switching to ${at}`).toEqual(all);
        }
        expect(live.opened.sort()).toEqual(all);
        expect(text('.projects')).toBe('p1 p1 1 1');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A push reaches the page through the store.
        live.push('projects', [{ id: 'p1' }, { id: 'p2' }]);
        await tick();
        expect(text('.projects')).toBe('p1,p2 p1 1 1');

        close();
        expect(live.open()).toEqual([]);
    });

    it('follows the viewer’s workspace', async () => {
        const live = workspaceTransport();
        const workspace = signal({ id: 'ws1' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useWorkspaceStore();
            return () => <p class="zone">{store.zone}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.open()).toEqual(METHODS.map((m) => `ws:ws1#${m}`).sort());
        workspace.id = 'ws2';
        await tick();
        expect(live.open()).toEqual(METHODS.map((m) => `ws:ws2#${m}`).sort());
        workspace.id = null;
        await tick();
        expect(live.open()).toEqual([]);
        expect(text('.zone')).toBe('UTC');
    });

    it('reads nothing and answers empty without actor definitions (mock data)', async () => {
        const live = workspaceTransport();
        const Shell = component(() => {
            initAppStores();
            const store = useWorkspaceStore();
            return () => <p class="zone">{store.zone} {store.projects.length} {String(store.indexRead.loading)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws1' }, false);
        await tick();
        expect(live.opened).toEqual([]);
        expect(live.calls).toEqual([]);
        expect(text('.zone')).toBe('UTC 0 false');
    });
});
