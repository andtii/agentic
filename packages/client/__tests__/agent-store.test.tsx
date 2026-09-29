// @vitest-environment happy-dom
/**
 * The agent store (#1119, #1125): the shell creates it, pages read the agent
 * directory through it, and it reads the agents' summaries off the Workspace
 * index — no `Agent` call and no `Agent` socket, ever. Navigating between pages
 * opens no new subscription, and a rename (a new index frame) reaches every
 * page without a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useAgentStore, useKeyValueStorage, useViewer, type ActorDefs } from '../src/index';

const summary = (id: string, name: string, configVersion = 1) => ({ id, configVersion, config: { name, role: '', description: '', execution: { runtime: 'anthropic-api' } } });

/** A transport answering the Workspace's reads (and counting any Agent call); its live channel records every subscription. */
function agentsTransport(initial: string[]) {
    const state = {
        agents: initial,
        agentSummaries: Object.fromEntries(initial.map((id) => [id, summary(id, `agent ${id}`)])) as Record<string, ReturnType<typeof summary>>
    };
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const closed: string[] = [];
    const agentCalls: string[] = [];
    const index = () => ({ settings: {}, machines: [], agents: state.agents, agentSummaries: state.agentSummaries, chats: [], schedules: [] });
    const transport: ActorTransport = {
        name: 'agents',
        call: async (symbol, args) => {
            const [type, method] = symbol.split('#');
            if (type === 'Agent') {
                agentCalls.push(String((args as unknown[])[0]));
                throw new Error('the directory must not read an Agent');
            }
            if (method === 'get') return index();
            return method === 'projects' ? [] : method === 'listMachines' ? [] : { projects: [], unassigned: 0 };
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                const name = `${sub.type}:${sub.key}#${sub.method}`;
                open.set(sub, onValue);
                opened.push(name);
                return () => {
                    open.delete(sub);
                    closed.push(name);
                };
            }
        })
    };
    /** Push the index as it is now to the Workspace `get` subscribers. */
    const pushIndex = (ws: string): void => {
        for (const [sub, fn] of open) if (sub.key === `ws:${ws}` && sub.method === 'get') fn(index());
    };
    const agentSubs = (): string[] => [...open.keys()].filter((s) => s.type === 'Agent').map((s) => s.key);
    return { state, transport, agentSubs, opened: () => [...opened].sort(), closed, agentCalls, pushIndex };
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

describe('useAgentStore (#1119, #1125)', () => {
    it('two page mount/unmount cycles open no new subscription, and none to an Agent', async () => {
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
        expect(text('.one')).toBe('agent a1@0,agent a2@1');
        const first = live.opened();
        expect(first).toContain('Workspace:ws:ws1#get');

        for (const at of ['none', 'two', 'none', 'one', 'none', 'two'] as const) {
            page.at = at;
            await tick();
            expect(live.agentSubs(), `after switching to ${at}`).toEqual([]);
        }
        expect(live.opened()).toEqual(first);
        expect(live.closed).toEqual([]);
        expect(live.agentCalls).toEqual([]);
        expect(text('.two')).toBe('a1,a2 false');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A rename is a new index frame: the page shows it with no reload and no Agent read.
        page.at = 'one';
        await tick();
        live.state.agentSummaries = { ...live.state.agentSummaries, a2: summary('a2', 'renamed', 2) };
        live.pushIndex('ws1');
        await tick();
        expect(text('.one')).toBe('agent a1@0,renamed@1');
        expect(live.agentSubs()).toEqual([]);
        expect(live.agentCalls).toEqual([]);

        close();
    });

    it('follows the index: an added agent appears once summarised, a removed one leaves and moves the rest up', async () => {
        const live = agentsTransport(['a1', 'a2']);
        const Shell = component(() => {
            initAppStores();
            const store = useAgentStore();
            return () => <p class="all">{names(store)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws2' });
        await tick();
        expect(text('.all')).toBe('agent a1@0,agent a2@1');

        // Listed, not summarised yet: left out until its summary lands.
        live.state.agents = ['a1', 'a2', 'a3'];
        live.pushIndex('ws2');
        await tick();
        expect(text('.all')).toBe('agent a1@0,agent a2@1');
        live.state.agentSummaries = { ...live.state.agentSummaries, a3: summary('a3', 'agent a3') };
        live.pushIndex('ws2');
        await tick();
        expect(text('.all')).toBe('agent a1@0,agent a2@1,agent a3@2');

        live.state.agents = ['a1', 'a3'];
        live.pushIndex('ws2');
        await tick();
        expect(text('.all')).toBe('agent a1@0,agent a3@1');
        expect(live.agentSubs()).toEqual([]);
        expect(live.agentCalls).toEqual([]);
    });

    it('answers empty once the viewer has no workspace', async () => {
        const live = agentsTransport(['a1']);
        const workspace = signal({ id: 'ws3' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useAgentStore();
            return () => <p class="all">{names(store)}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(text('.all')).toBe('agent a1@0');
        workspace.id = null;
        await tick();
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
