// @vitest-environment happy-dom
/**
 * The chat prefs store (#1124): the view prefs (#1058) and read marks (#152) over the injected
 * `KeyValueStorage`, one instance per app. Storage is read lazily, the first time a workspace is asked for,
 * and once per app: pages mounting and unmounting under the shell reuse what it holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { component, defineApp, signal, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { EXPANDED_CAP, chatSeenKey, chatViewKey, initAppStores, memoryKeyValueStorage, useChatPrefsStore, useKeyValueStorage, type KeyValueStorage } from '../src/index';

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    vi.restoreAllMocks();
});

/** A storage that counts its reads. */
function countingStorage(seed: Record<string, string> = {}): KeyValueStorage & { reads: string[] } {
    const inner = memoryKeyValueStorage(seed);
    const reads: string[] = [];
    return {
        reads,
        get: (key) => {
            reads.push(key);
            return inner.get(key);
        },
        set: (key, value) => inner.set(key, value),
        remove: (key) => inner.remove(key)
    };
}

type Store = ReturnType<typeof useChatPrefsStore>;

/** Mount a shell that creates the app stores and hands back the chat prefs store. */
function mount(storage: KeyValueStorage | null, tree?: (store: Store) => JSXElement): Store {
    let store: Store | null = null;
    const Shell = component(() => {
        initAppStores();
        const s = useChatPrefsStore();
        store = s;
        return () => (tree ? tree(s) : <p />);
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(<Shell />);
    if (storage) app.defineProvide(useKeyValueStorage, () => storage);
    app.mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return store!;
}

describe('view prefs', () => {
    it('keep the pin, the detail and the opened boxes per workspace and chat, in storage; a new app reads them back', () => {
        const storage = memoryKeyValueStorage();
        const a = mount(storage);
        a.setViewPin('ws1', 'c1', 'lanes');
        a.setViewDetail('ws1', 'c1', 'raw');
        a.setStepsExpanded('ws1', 'c1', 'm1', true);
        a.setStepsExpanded('ws1', 'c1', 'm2', true);
        a.setStepsExpanded('ws1', 'c1', 'm1', false);
        expect(a.viewPrefs('ws1', 'c1')).toEqual({ pin: 'lanes', detail: 'raw', expanded: ['m2'] });
        expect(a.viewPrefs('ws1', 'c2')).toEqual({ expanded: [] });

        const b = mount(storage);
        expect(b).not.toBe(a);
        expect(b.viewPrefs('ws1', 'c1')).toEqual({ pin: 'lanes', detail: 'raw', expanded: ['m2'] });
        expect(b.viewPrefs('ws2', 'c1')).toEqual({ expanded: [] });
    });

    it('unpins', () => {
        const s = mount(memoryKeyValueStorage());
        s.setViewPin('ws1', 'c1', 'team');
        s.setViewPin('ws1', 'c1', undefined);
        expect(s.viewPrefs('ws1', 'c1').pin).toBeUndefined();
    });

    it('drop what storage holds that they do not know, and keep only the newest opened boxes', () => {
        const s = mount(memoryKeyValueStorage({ [chatViewKey('ws1')]: JSON.stringify({ c1: { pin: 'grid', detail: 'all', expanded: ['m1', 3] }, c2: 'x' }) }));
        expect(s.viewPrefs('ws1', 'c1')).toEqual({ expanded: ['m1'] });
        expect(s.viewPrefs('ws1', 'c2')).toEqual({ expanded: [] });
        for (let i = 0; i < EXPANDED_CAP + 5; i++) s.setStepsExpanded('ws1', 'c3', `m${i}`, true);
        expect(s.viewPrefs('ws1', 'c3').expanded).toHaveLength(EXPANDED_CAP);
        expect(s.viewPrefs('ws1', 'c3').expanded[0]).toBe('m5');
    });

    it('live for the app when storage refuses, or when the app provides none', () => {
        const refusing: KeyValueStorage = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('quota'); }, remove: () => undefined };
        for (const storage of [refusing, null]) {
            const s = mount(storage);
            s.setViewDetail('ws1', 'c1', 'messages');
            expect(s.viewPrefs('ws1', 'c1').detail).toBe('messages');
        }
    });
});

describe('read marks', () => {
    it('load from storage only when asked, only move forward, and are kept per workspace', () => {
        const storage = memoryKeyValueStorage({ [chatSeenKey('u1')]: JSON.stringify({ c1: 4, junk: 'x' }) });
        const s = mount(storage);
        expect(s.readMarks('u1')).toEqual({});
        s.loadReadMarks('u1');
        expect(s.readMarks('u1')).toEqual({ c1: 4 });
        s.markSeen('u1', 'c1', 2);
        s.markSeen('u1', 'c2', 7);
        expect(s.readMarks('u1')).toEqual({ c1: 4, c2: 7 });
        expect(JSON.parse(storage.get(chatSeenKey('u1'))!)).toEqual({ c1: 4, c2: 7 });
        expect(s.readMarks('u2')).toEqual({});
        expect(s.readMarks(null)).toEqual({});
    });

    it('a first sight starts a chat at its present end and leaves known chats alone', () => {
        const s = mount(memoryKeyValueStorage());
        s.markSeen('u1', 'c1', 3);
        s.baselineReadMarks('u1', [{ id: 'c1', seq: 9 }, { id: 'c2', seq: 5 }]);
        expect(s.readMarks('u1')).toEqual({ c1: 3, c2: 5 });
    });

    it('survive storage that holds garbage or refuses a write', () => {
        const storage = memoryKeyValueStorage({ [chatSeenKey('u1')]: '{not json' });
        const s = mount({ ...storage, set: () => { throw new Error('quota'); } });
        s.loadReadMarks('u1');
        expect(s.readMarks('u1')).toEqual({});
        s.markSeen('u1', 'c1', 1);
        expect(s.readMarks('u1')).toEqual({ c1: 1 });
    });
});

describe('one store per app', () => {
    it('reads nothing until asked, and pages mounting and unmounting under the shell share it: storage is read once', async () => {
        const storage = countingStorage({ [chatViewKey('ws1')]: JSON.stringify({ c1: { pin: 'lanes', expanded: [] } }) });
        const at = signal({ page: 'a' as 'a' | 'b' | 'none' });
        const seen: Store[] = [];
        const Page = component<{ name: string }>(({ props }) => {
            const s = useChatPrefsStore();
            seen.push(s);
            return () => <p class={props.name}>{s.viewPrefs('ws1', 'c1').pin ?? 'auto'}</p>;
        });
        const shell = mount(storage, () => <main>{at.page === 'none' ? null : <Page name={at.page} />}</main>);
        expect(storage.reads).toEqual([chatViewKey('ws1')]);
        await tick();
        expect(document.querySelector('.a')?.textContent).toBe('lanes');

        // Two full cycles: the pin a page sets reaches the next page with no new read.
        for (const page of ['none', 'b', 'none', 'a', 'none', 'b'] as const) {
            at.page = page;
            await tick();
            if (page === 'b') shell.setViewPin('ws1', 'c1', 'team');
        }
        await tick();
        expect(document.querySelector('.b')?.textContent).toBe('team');
        expect(new Set(seen)).toEqual(new Set([shell]));
        expect(storage.reads).toEqual([chatViewKey('ws1')]);
    });

    it('creating the store reads no storage: a server render and the render that hydrates it stay on the defaults', () => {
        const storage = countingStorage();
        mount(storage);
        expect(storage.reads).toEqual([]);
    });
});
