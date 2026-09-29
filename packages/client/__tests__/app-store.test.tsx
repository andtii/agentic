// @vitest-environment happy-dom
/**
 * The app store foundation (#1116): a store created by `initAppStores()` in a
 * persistent shell keeps its live read open while pages mount and unmount
 * under it, follows the viewer's workspace, and closes it when the app goes
 * (`ctx.onDeactivated`). A store a page creates first warns in dev.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorSubscription, type ActorTransport } from '@sigx/actors/client';
import type { AnyActorDefinition } from '@sigx/actors';
import { defineAppStore, initAppStores, memoryKeyValueStorage, useKeyValueStorage, useLiveActorState, useViewer } from '../src/index';
import { outsideInitMessage } from '../src/stores/define';

/** A transport whose live channel counts what is open: every `subscribe` adds one, its unsubscribe takes it away. */
function countingTransport() {
    const open = new Map<ActorSubscription, (value: unknown) => void>();
    const opened: string[] = [];
    const transport: ActorTransport = {
        name: 'counting',
        call: async () => 1,
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
        live: () => ({
            subscribe(sub, onValue) {
                open.set(sub, onValue);
                opened.push(sub.key);
                return () => void open.delete(sub);
            }
        })
    };
    return { transport, open: () => [...open.keys()].map((s) => s.key), opened, push: (value: unknown) => open.forEach((fn) => fn(value)) };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    vi.restoreAllMocks();
});

function mount(tree: JSXElement, transport: ActorTransport, workspace: { id: string | null } = { id: 'ws1' }): () => void {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(actorsPlugin({ transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
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

const initMessages = (warn: { mock: { calls: unknown[][] } }): string[] => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('initAppStores'));

// The stand-in actor: a client ref to `counter`, read live through `get`.
interface CounterDef extends AnyActorDefinition {
    readonly __counter: true;
}
const Counter = __actorRef('counter', '/_sigx/actor', [], []) as unknown as CounterDef;

const useCounterStore = defineAppStore('test-counter', (ctx) => {
    const viewer = useViewer()();
    const read = useLiveActorState(ctx, Counter, () => (viewer.workspaceId ? ([viewer.workspaceId, 'get'] as never) : null));
    return {
        get count(): unknown {
            return read.value;
        }
    };
});

describe('app stores (#1116)', () => {
    it('keep one live subscription across two page mount/unmount cycles when the shell creates them, and close it with the app', async () => {
        const live = countingTransport();
        const page = signal({ at: 'a' as 'a' | 'b' | 'none' });
        const PageA = component(() => {
            const store = useCounterStore();
            return () => <p class="a">{String(store.count)}</p>;
        });
        const PageB = component(() => {
            const store = useCounterStore();
            return () => <p class="b">{String(store.count)}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <main>{page.at === 'a' ? <PageA /> : page.at === 'b' ? <PageB /> : null}</main>;
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const close = mount(<Shell />, live.transport);
        await tick();
        expect(live.open()).toEqual(['ws1']);
        expect(document.querySelector('.a')?.textContent).toBe('1');

        // Page A leaves, page B comes and goes, page A comes back and leaves: two full cycles.
        for (const at of ['none', 'b', 'none', 'a', 'none'] as const) {
            page.at = at;
            await tick();
            expect(live.open(), `after switching to ${at}`).toEqual(['ws1']);
        }
        expect(live.opened).toEqual(['ws1']);

        // Still live: a pushed value reaches a page mounted after the churn.
        page.at = 'b';
        await tick();
        live.push(7);
        await tick();
        expect(document.querySelector('.b')?.textContent).toBe('7');
        expect(initMessages(warn)).toEqual([]);

        // The app goes, and the store's subscription with it.
        close();
        expect(live.open()).toEqual([]);
    });

    it('follows the viewer’s workspace: the old subscription closes, the new one opens', async () => {
        const live = countingTransport();
        const workspace = signal({ id: 'ws1' as string | null });
        const Shell = component(() => {
            initAppStores();
            const store = useCounterStore();
            return () => <p>{String(store.count)}</p>;
        });
        mount(<Shell />, live.transport, workspace);
        await tick();
        expect(live.open()).toEqual(['ws1']);
        workspace.id = 'ws2';
        await tick();
        expect(live.open()).toEqual(['ws2']);
        workspace.id = null;
        await tick();
        expect(live.open()).toEqual([]);
        expect(live.opened).toEqual(['ws1', 'ws2']);
    });

    it('warns in dev when a page creates the store first', async () => {
        const useLateStore = defineAppStore('test-late', () => ({ n: 1 }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const Page = component(() => {
            const store = useLateStore();
            return () => <p>{store.n}</p>;
        });
        // A shell that never calls initAppStores(): the page is the first to create the store.
        const Shell = component(() => () => <Page />);
        mount(<Shell />, countingTransport().transport);
        await tick();
        expect(warn).toHaveBeenCalledWith(outsideInitMessage('test-late'));
    });

    it('does not warn when initAppStores() created it first', async () => {
        const useEarlyStore = defineAppStore('test-early', () => ({ n: 1 }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const Page = component(() => {
            const store = useEarlyStore();
            return () => <p>{store.n}</p>;
        });
        const Shell = component(() => {
            initAppStores();
            return () => <Page />;
        });
        mount(<Shell />, countingTransport().transport);
        await tick();
        expect(initMessages(warn)).toEqual([]);
    });
});

describe('memoryKeyValueStorage', () => {
    it('gets, sets and removes', () => {
        const kv = memoryKeyValueStorage({ a: '1' });
        expect(kv.get('a')).toBe('1');
        kv.set('b', '2');
        expect(kv.get('b')).toBe('2');
        kv.remove('a');
        expect(kv.get('a')).toBeNull();
    });
});
