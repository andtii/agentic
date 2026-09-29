// @vitest-environment happy-dom
/**
 * The inbox store (#1123): the shell creates it, the badge and the pages read
 * "Needs you" through it, and navigating between those pages opens no new
 * subscription — one live read each of `Inbox.list`, `Routing.get` and
 * `Audit.stats` for the app's lifetime, following the viewer's workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { INTERRUPTION_AUDIT_KINDS, initAppStores, memoryKeyValueStorage, useActorDefs, useInboxStore, useKeyValueStorage, useViewer, type ActorDefs } from '../src/index';

const LIVE = ['Inbox#list', 'Routing#get', 'Audit#stats'];

const notice = (id: string) => ({ id, kind: 'approval', title: `Approve ${id}`, at: 1, read: false });

/** A transport answering the three actors' reads; its live channel records every subscription and counts the open ones. */
function inboxTransport() {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const calls: { symbol: string; args: unknown[] }[] = [];
    const answers: Record<string, unknown> = {
        'Inbox#list': [notice('n1')],
        'Routing#get': { routes: [{ taskId: 't1', status: 'interrupted' }] },
        'Audit#stats': { inState: 1, recorded: 1, archived: 0, months: [] },
        'Audit#list': { events: [{ id: 'e1', kind: 'session.interrupted' }] }
    };
    const transport: ActorTransport = {
        name: 'inbox',
        call: async (symbol, args) => {
            if (symbol.startsWith('Workspace#')) return undefined;
            calls.push({ symbol, args });
            return answers[symbol];
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                if (sub.type === 'Workspace') return () => undefined;
                open.set(sub, onValue);
                opened.push(`${sub.type}#${sub.method}@${sub.key}`);
                return () => void open.delete(sub);
            }
        })
    };
    const push = (method: string, value: unknown): void => {
        for (const [sub, fn] of open) if (`${sub.type}#${sub.method}` === method) fn(value);
    };
    return { transport, open: () => [...open.keys()].map((s) => `${s.type}#${s.method}@${s.key}`).sort(), opened, calls, push };
}

const defs = {
    Inbox: __actorRef('Inbox', '/_sigx/actor', [], []),
    Routing: __actorRef('Routing', '/_sigx/actor', [], []),
    Audit: __actorRef('Audit', '/_sigx/actor', [], []),
    // The workspace store is registered too (`initAppStores()` creates every store); its reads are not counted here.
    Workspace: __actorRef('Workspace', '/_sigx/actor', [], [])
} as unknown as ActorDefs;

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
    if (withDefs) app.defineProvide(useActorDefs, () => defs);
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
const liveAt = (ws: string): string[] => [`Audit#stats@${ws}:audit`, `Inbox#list@${ws}:inbox`, `Routing#get@${ws}:routing:main`];

describe('useInboxStore (#1123)', () => {
    it('reads "Needs you" once per app: the badge and two page mount/unmount cycles share one subscription each', async () => {
        const live = inboxTransport();
        const page = signal({ at: 'home' as 'home' | 'chat' | 'none' });
        const Home = component(() => {
            const store = useInboxStore();
            return () => <p class="home">{store.notifications.length} open · {store.routes.length} routes · {store.interruptions.length} cuts</p>;
        });
        const Chat = component(() => {
            const store = useInboxStore();
            return () => <p class="chat">{store.notifications.map((n) => n.id).join(',')}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            const store = useInboxStore();
            return () => (
                <main>
                    <span class="badge">{store.notifications.length}</span>
                    {page.at === 'home' ? <Home /> : page.at === 'chat' ? <Chat /> : null}
                </main>
            );
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        expect(live.open()).toEqual(liveAt('ws1'));
        expect(text('.badge')).toBe('1');
        expect(text('.home')).toBe('1 open · 1 routes · 1 cuts');

        const listsAtStart = live.calls.filter((c) => c.symbol === 'Audit#list').length;
        for (const at of ['none', 'chat', 'none', 'home', 'none', 'chat'] as const) {
            page.at = at;
            await tick();
            expect(live.open(), `after switching to ${at}`).toEqual(liveAt('ws1'));
        }
        expect(live.opened.sort()).toEqual(liveAt('ws1'));
        expect(text('.chat')).toBe('n1');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // The interruption rows are read workspace-wide, for the interruption kinds — and not again on a page mount.
        const lists = live.calls.filter((c) => c.symbol === 'Audit#list');
        expect(lists).toHaveLength(listsAtStart);
        expect(JSON.stringify(lists.at(-1)!.args)).toContain(JSON.stringify([...INTERRUPTION_AUDIT_KINDS]));

        // A push reaches the badge and the page through the store.
        live.push('Inbox#list', [notice('n1'), notice('n2')]);
        await tick();
        expect(text('.badge')).toBe('2');
        expect(text('.chat')).toBe('n1,n2');

        // A recorded audit row re-reads the interruption rows.
        live.push('Audit#stats', { inState: 2, recorded: 2, archived: 0, months: [] });
        await tick();
        expect(live.calls.filter((c) => c.symbol === 'Audit#list')).toHaveLength(listsAtStart + 1);

        close();
        expect(live.open()).toEqual([]);
    });

    it('follows the viewer’s workspace', async () => {
        const live = inboxTransport();
        const workspace = signal({ id: 'ws1' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useInboxStore();
            return () => <p class="badge">{store.notifications.length}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.open()).toEqual(liveAt('ws1'));
        workspace.id = 'ws2';
        await tick();
        expect(live.open()).toEqual(liveAt('ws2'));
        workspace.id = null;
        await tick();
        expect(live.open()).toEqual([]);
        expect(text('.badge')).toBe('0');
    });

    it('reads nothing and answers empty without actor definitions (mock data)', async () => {
        const live = inboxTransport();
        const Shell = component(() => {
            initAppStores();
            const store = useInboxStore();
            return () => <p class="badge">{store.notifications.length} {store.routes.length} {store.interruptions.length} {store.auditRecorded} {String(store.listRead.loading)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws1' }, false);
        await tick();
        expect(live.opened).toEqual([]);
        expect(live.calls).toEqual([]);
        expect(text('.badge')).toBe('0 0 0 -1 false');
    });
});
