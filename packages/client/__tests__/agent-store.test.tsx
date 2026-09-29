// @vitest-environment happy-dom
/**
 * The agent store (#1119): the shell creates it, pages read the agent
 * directory through it, and navigating between those pages opens no new
 * subscription — one live `Agent.get` per agent for the app's lifetime,
 * following the Workspace index's agent ids.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useAgentStore, useKeyValueStorage, useViewer, type ActorDefs } from '../src/index';

const agentView = (id: string, name: string) => ({ id, config: { name }, configVersion: 1 });

/** A transport answering the Workspace's and the Agents' reads; its live channel records every subscription and counts the open ones. */
function agentsTransport(initial: string[]) {
    const state = { agents: initial };
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const closed: string[] = [];
    const agentCalls: string[] = [];
    const transport: ActorTransport = {
        name: 'agents',
        call: async (symbol, args) => {
            const [type, method] = symbol.split('#');
            if (type === 'Agent') {
                const key = String((args as unknown[])[0]);
                agentCalls.push(key);
                const id = key.split(':').pop()!;
                return agentView(id, `fetched ${id}`);
            }
            if (method === 'get') return { settings: {}, machines: [], agents: state.agents, chats: [], schedules: [] };
            return method === 'projects' ? [] : method === 'listMachines' ? [] : { projects: [], unassigned: 0 };
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                open.set(sub, onValue);
                opened.push(sub.key);
                return () => {
                    open.delete(sub);
                    closed.push(sub.key);
                };
            }
        })
    };
    const push = (key: string, method: string, value: unknown): void => {
        for (const [sub, fn] of open) if (sub.key === key && sub.method === method) fn(value);
    };
    const agentSubs = (): string[] => [...open.keys()].filter((s) => s.type === 'Agent').map((s) => s.key).sort();
    return { state, transport, agentSubs, opened: () => opened.filter((k) => !k.startsWith('ws:')).sort(), closed, agentCalls, push };
}

const Workspace = __actorRef('Workspace', '/_sigx/actor', [], []);
const AgentActor = __actorRef('Agent', '/_sigx/actor', [], []);

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
    if (withDefs) app.defineProvide(useActorDefs, () => ({ Workspace, AgentActor }) as unknown as ActorDefs);
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
const names = (store: ReturnType<typeof useAgentStore>): string =>
    Object.values(store.agents)
        .map((e) => `${e.view.config.name}@${e.index}`)
        .join(',');

const key = (id: string, ws = 'ws1'): string => `${ws}:agent:${id}`;

describe('useAgentStore (#1119)', () => {
    it('subscribes once per agent per app: two page mount/unmount cycles open no new subscription', async () => {
        const live = agentsTransport(['a1', 'a2']);
        const page = signal({ at: 'one' as 'one' | 'two' | 'none' });
        const One = component(() => {
            const store = useAgentStore();
            return () => <p class="one">{names(store)}</p>;
        });
        const Two = component(() => {
            const store = useAgentStore();
            return () => <p class="two">{Object.keys(store.agents).join(',')} {String(store.loading)}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'one' ? <One /> : page.at === 'two' ? <Two /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        const both = [key('a1'), key('a2')];
        expect(live.agentSubs()).toEqual(both);
        expect(text('.one')).toBe('fetched a1@0,fetched a2@1');

        for (const at of ['none', 'two', 'none', 'one', 'none', 'two'] as const) {
            page.at = at;
            await tick();
            expect(live.agentSubs(), `after switching to ${at}`).toEqual(both);
        }
        expect(live.opened()).toEqual(both);
        expect(live.closed).toEqual([]);
        expect(text('.two')).toBe('a1,a2 false');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A frame replaces the fetched view.
        page.at = 'one';
        await tick();
        live.push(key('a2'), 'get', agentView('a2', 'renamed'));
        await tick();
        expect(text('.one')).toBe('fetched a1@0,renamed@1');

        close();
        expect(live.agentSubs()).toEqual([]);
    });

    it('adding or removing an agent in the index subscribes or closes only that agent', async () => {
        const live = agentsTransport(['a1', 'a2']);
        const Shell = component(() => {
            initAppStores();
            const store = useAgentStore();
            return () => <p class="all">{names(store)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws2' });
        await tick();
        expect(live.agentSubs()).toEqual([key('a1', 'ws2'), key('a2', 'ws2')]);

        live.state.agents = ['a1', 'a2', 'a3'];
        live.push('ws:ws2', 'get', { settings: {}, machines: [], agents: live.state.agents, chats: [], schedules: [] });
        await tick();
        expect(live.agentSubs()).toEqual([key('a1', 'ws2'), key('a2', 'ws2'), key('a3', 'ws2')]);
        expect(live.opened()).toEqual([key('a1', 'ws2'), key('a2', 'ws2'), key('a3', 'ws2')]);
        expect(live.closed).toEqual([]);
        expect(text('.all')).toBe('fetched a1@0,fetched a2@1,fetched a3@2');
        live.push(key('a3', 'ws2'), 'get', agentView('a3', 'live a3'));
        await tick();
        expect(text('.all')).toBe('fetched a1@0,fetched a2@1,live a3@2');

        live.state.agents = ['a1', 'a3'];
        live.push('ws:ws2', 'get', { settings: {}, machines: [], agents: live.state.agents, chats: [], schedules: [] });
        await tick();
        expect(live.agentSubs()).toEqual([key('a1', 'ws2'), key('a3', 'ws2')]);
        expect(live.closed).toEqual([key('a2', 'ws2')]);
        // The live a3 moves to the removed agent's place.
        expect(text('.all')).toBe('fetched a1@0,live a3@1');
        expect(live.opened()).toEqual([key('a1', 'ws2'), key('a2', 'ws2'), key('a3', 'ws2')]);
    });

    it('closes every agent on a workspace switch', async () => {
        const live = agentsTransport(['a1']);
        const workspace = signal({ id: 'ws3' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useAgentStore();
            return () => <p class="all">{names(store)}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.agentSubs()).toEqual([key('a1', 'ws3')]);
        workspace.id = null;
        await tick();
        expect(live.agentSubs()).toEqual([]);
        expect(text('.all')).toBe('');
    });

    it('reads nothing and answers empty without actor definitions (mock data)', async () => {
        const live = agentsTransport(['a1']);
        const Shell = component(() => {
            initAppStores();
            const store = useAgentStore();
            return () => <p class="all">{Object.keys(store.agents).length} {String(store.loading)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws4' }, false);
        await tick();
        expect(live.opened()).toEqual([]);
        expect(live.agentCalls).toEqual([]);
        expect(text('.all')).toBe('0 false');
    });
});
