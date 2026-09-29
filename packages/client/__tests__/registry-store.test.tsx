// @vitest-environment happy-dom
/**
 * The registry store (#1121): the shell creates it, pages read the Registry and
 * the connector accounts through it, and navigating between those pages opens
 * no new subscription — one live read each of `Registry.overview`,
 * `connectors`, `projectFeatures`, `secrets` and `ConnectorAccounts.accounts`
 * for the app's lifetime, following the viewer's workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useKeyValueStorage, useRegistryStore, useViewer, type ActorDefs } from '../src/index';

const REGISTRY = ['overview', 'connectors', 'projectFeatures', 'secrets'] as const;

/** What the Registry and ConnectorAccounts answer, per method. */
const answers: Record<string, unknown> = {
    overview: { plugins: [{ manifest: { id: 'gmail', name: 'Gmail', kind: 'connector' } }], secretNames: ['k'], hasKek: true, active: {} },
    connectors: [{ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'a1', tools: [], status: { state: 'ok' } }],
    projectFeatures: [{ id: 'git', ui: { label: 'Git' } }],
    secrets: [{ name: 'k', updatedAt: 1 }],
    accounts: [{ id: 'a1', connector: 'gmail', status: 'active' }]
};

/** A transport answering the reads; its live channel records every subscription and counts the open ones. */
function registryTransport() {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const calls: string[] = [];
    const transport: ActorTransport = {
        name: 'registry',
        call: async (symbol) => {
            const [type, method] = symbol.split('#') as [string, string];
            if (type === 'Workspace') return method === 'get' ? { settings: {}, machines: [], agents: [], chats: [] } : [];
            calls.push(method);
            return answers[method];
        },
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                if (!ours(sub.key)) return () => undefined;
                open.set(sub, onValue);
                opened.push(`${sub.key}#${sub.method}`);
                return () => void open.delete(sub);
            }
        })
    };
    const ours = (key: string): boolean => key.endsWith(':registry') || key.endsWith(':connector-accounts');
    const push = (method: string, value: unknown): void => {
        for (const [sub, fn] of open) if (sub.method === method) fn(value);
    };
    return { transport, open: () => [...open.keys()].map((s) => `${s.key}#${s.method}`).sort(), opened, calls, push };
}

const Registry = __actorRef('Registry', '/_sigx/actor', [], []);
const ConnectorAccounts = __actorRef('ConnectorAccounts', '/_sigx/actor', [], []);
/** The workspace store's actor: provided so that store reads too; this file counts only the Registry's and the accounts' subscriptions. */
const Workspace = __actorRef('Workspace', '/_sigx/actor', [], []);

const all = (ws: string): string[] => [...REGISTRY.map((m) => `${ws}:registry#${m}`), `${ws}:connector-accounts#accounts`].sort();

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
    if (withDefs) app.defineProvide(useActorDefs, () => ({ Registry, ConnectorAccounts, Workspace }) as unknown as ActorDefs);
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

describe('useRegistryStore (#1121)', () => {
    it('reads the Registry and the accounts once per app: two page mount/unmount cycles open no new subscription', async () => {
        const live = registryTransport();
        const page = signal({ at: 'plugins' as 'plugins' | 'features' | 'none' });
        const PluginsPage = component(() => {
            const store = useRegistryStore();
            return () => <p class="plugins">{store.overview?.plugins.map((p) => p.manifest.id).join(',')} {String(store.connectors?.length)} {String(store.accounts?.length)} {store.signedOut.join(',') || '-'}</p>;
        });
        const FeaturesPage = component(() => {
            const store = useRegistryStore();
            return () => <p class="features">{store.projectFeatures.map((f) => f.id).join(',')} {String(store.secrets?.length)}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'plugins' ? <PluginsPage /> : page.at === 'features' ? <FeaturesPage /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const close = mount(<Shell />, live.transport, { id: 'ws1' });
        await tick();
        expect(live.open()).toEqual(all('ws1'));
        expect(text('.plugins')).toBe('gmail 1 1 -');

        for (const at of ['none', 'features', 'none', 'plugins', 'none', 'features'] as const) {
            page.at = at;
            await tick();
            expect(live.open(), `after switching to ${at}`).toEqual(all('ws1'));
        }
        expect(live.opened.sort()).toEqual(all('ws1'));
        expect(text('.features')).toBe('git 1');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'))).toEqual([]);

        // A push reaches the page through the store: the account needs signing in again.
        page.at = 'plugins';
        await tick();
        live.push('accounts', [{ id: 'a1', connector: 'gmail', status: 'needsReauth' }]);
        await tick();
        expect(text('.plugins')).toBe('gmail 1 1 gmail');
        expect(live.opened.sort()).toEqual(all('ws1'));

        close();
        expect(live.open()).toEqual([]);
    });

    it('follows the viewer’s workspace', async () => {
        const live = registryTransport();
        const workspace = signal({ id: 'ws1' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useRegistryStore();
            return () => <p class="features">{store.projectFeatures.length}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.open()).toEqual(all('ws1'));
        workspace.id = 'ws2';
        await tick();
        expect(live.open()).toEqual(all('ws2'));
        workspace.id = null;
        await tick();
        expect(live.open()).toEqual([]);
    });

    it('reads nothing and answers empty without actor definitions (mock data)', async () => {
        const live = registryTransport();
        const Shell = component(() => {
            initAppStores();
            const store = useRegistryStore();
            return () => <p class="empty">{String(store.overview)} {store.projectFeatures.length} {store.signedOut.length} {String(store.overviewRead.loading)}</p>;
        });
        mount(<Shell />, live.transport, { id: 'ws1' }, false);
        await tick();
        expect(live.opened).toEqual([]);
        expect(live.calls).toEqual([]);
        expect(text('.empty')).toBe('undefined 0 0 false');
    });
});
