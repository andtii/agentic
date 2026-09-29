// @vitest-environment happy-dom
/**
 * The machines store (#1120): the shell creates it, the machine pages read
 * each paired machine's `Machine.get` through it, and navigating between them
 * opens no new subscription — one live read per paired machine for the app's
 * lifetime, diffed as machines are paired and unpaired.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import type { MachineView } from '@agentic/platform';
import { foldEnvironments, initAppStores, memoryKeyValueStorage, useActorDefs, useKeyValueStorage, useMachineStore, useViewer, type ActorDefs } from '../src/index';

const env = (id: string, label: string) => ({ id, runtime: 'claude-code', account: { label } });
const machineView = (id: string, extra: Partial<Record<string, unknown>> = {}): MachineView =>
    ({ id, name: id === 'm1' ? 'Desk' : 'Laptop', online: true, revoked: false, environments: [env('e2', 'work'), env('e1', 'home')], activeSessions: [], quota: {}, ...extra }) as unknown as MachineView;

/** A transport answering the Workspace's and the Machines' reads; its live channel records every subscription. */
function machinesTransport(paired: { ids: string[] }) {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const gets: string[] = [];
    const transport: ActorTransport = {
        name: 'machines',
        call: async (symbol, args) => {
            const method = symbol.split('#')[1];
            if (symbol.startsWith('Workspace')) {
                if (method === 'listMachines') return paired.ids.map((id) => ({ id, name: id, status: 'paired' })).concat([{ id: 'm9', name: 'Old', status: 'unpaired' }]);
                return method === 'get' ? { settings: {}, machines: [], lastMachineId: 'm1', agents: [], chats: [] } : method === 'projects' ? [] : { projects: [], unassigned: 0 };
            }
            const key = String((args as unknown[])[0]);
            gets.push(key);
            return machineView(key.split(':machine:')[1]!);
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                open.set(sub, onValue);
                opened.push(sub.key);
                return () => void open.delete(sub);
            }
        })
    };
    const push = (key: string, value: unknown): void => {
        for (const [sub, fn] of open) if (sub.key === key && sub.method === 'get') fn(value);
    };
    const machines = (): string[] => [...open.keys()].filter((s) => s.key.includes(':machine:')).map((s) => s.key).sort();
    return { transport, machines, opened, gets, push };
}

const Workspace = __actorRef('Workspace', '/_sigx/actor', [], []);
const Machine = __actorRef('Machine', '/_sigx/actor', [], []);

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    vi.restoreAllMocks();
});

function mount(tree: JSXElement, transport: ActorTransport, workspace: { id: string | null }): () => void {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(actorsPlugin({ transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
    app.defineProvide(useActorDefs, () => ({ Workspace, Machine }) as unknown as ActorDefs);
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

describe('useMachineStore (#1120)', () => {
    it('reads each paired machine once per app: two page mount/unmount cycles open no new subscription', async () => {
        const live = machinesTransport({ ids: ['m1', 'm2'] });
        const page = signal({ at: 'rows' as 'rows' | 'envs' | 'none' });
        const RowsPage = component(() => {
            const store = useMachineStore();
            return () => <p class="rows">{store.paired.map((m) => `${m.id}:${store.machine(m.id)?.name ?? '-'}:${String(store.machine(m.id)?.online)}`).join(',')}</p>;
        });
        const EnvsPage = component(() => {
            const store = useMachineStore();
            return () => <p class="envs">{store.environments.map((e) => e.label).join(',')} {store.machines.length} {store.accounts().length}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'rows' ? <RowsPage /> : page.at === 'envs' ? <EnvsPage /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        const all = ['ws1:machine:m1', 'ws1:machine:m2'];
        expect(live.machines()).toEqual(all);
        expect(text('.rows')).toBe('m1:Desk:true,m2:Laptop:true');
        const fetches = live.gets.length;

        for (const at of ['none', 'envs', 'none', 'rows', 'none', 'envs'] as const) {
            page.at = at;
            await tick();
            expect(live.machines(), `after switching to ${at}`).toEqual(all);
        }
        expect(live.opened.filter((k) => k.includes(':machine:')).sort()).toEqual(all);
        expect(live.gets.length).toBe(fetches);
        expect(text('.envs')).toBe('Desk / claude-code / home,Desk / claude-code / work,Laptop / claude-code / home,Laptop / claude-code / work 2 2');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A push reaches the page through the store; a revoked machine leaves the directory.
        live.push('ws1:machine:m2', machineView('m2', { revoked: true }));
        await tick();
        expect(text('.envs')).toBe('Desk / claude-code / home,Desk / claude-code / work 1 2');

        close();
        expect(live.machines()).toEqual([]);
    });

    it('diffs the paired list and follows the viewer’s workspace', async () => {
        const paired = { ids: ['m1'] };
        const live = machinesTransport(paired);
        const workspace = signal({ id: 'wsA' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useMachineStore();
            return () => <p class="rows">{Object.keys(store.views).join(',')}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.machines()).toEqual(['wsA:machine:m1']);
        paired.ids = ['m1', 'm2'];
        workspace.id = 'wsB';
        await tick();
        expect(live.machines()).toEqual(['wsB:machine:m1', 'wsB:machine:m2']);
        expect(text('.rows')).toBe('m1,m2');
        workspace.id = null;
        await tick();
        expect(live.machines()).toEqual([]);
        expect(text('.rows')).toBe('');
    });
});

describe('foldEnvironments', () => {
    it('orders by machine then environment id and skips revoked or unread machines', () => {
        const out = foldEnvironments(['m2', 'm1', 'm3'], { m1: machineView('m1'), m2: machineView('m2', { revoked: true }) });
        expect(out.machines.map((m) => m.id)).toEqual(['m1']);
        expect(out.entries.map((e) => `${e.machineId}/${e.id}`)).toEqual(['m1/e1', 'm1/e2']);
        expect(out.entries[0]).toMatchObject({ machineName: 'Desk', line: { machine: 'Desk', runtime: 'claude-code', account: 'home' }, quota: null });
    });
});
