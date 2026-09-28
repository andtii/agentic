/** Fakes for the export tests (#994): a Durable Object's state over a Map, and one seeded like a live Session's object. */
import { durableObjectReminders, durableObjectStorage, type DurableObjectStateLike } from '@sigx/actors-cloudflare';

/** A Durable Object's storage over a sorted Map: `list({ prefix })` in key order, as workerd does. */
export function fakeObjectState(name?: string): DurableObjectStateLike {
    const map = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
        get: async <T>(key: string) => map.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
        delete: async (key: string) => map.delete(key),
        list: async <T>({ prefix }: { prefix: string }) => new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, T][]),
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => void (alarm = t),
        deleteAlarm: async () => void (alarm = null)
    };
    return { id: { toString: () => 'a'.repeat(64), ...(name ? { name } : {}) }, storage, blockConcurrencyWhile: (fn) => fn() };
}

/** An object holding a Session with two appended events, its task record, and one periodic and one one-shot reminder. */
export async function seededObject(): Promise<DurableObjectStateLike> {
    const state = fakeObjectState();
    const store = durableObjectStorage(state.storage);
    let etag = await store.save('Session', 'ws:s1', { title: 'hello', events: [] }, null);
    etag = await store.appendText!('Session', 'ws:s1', JSON.stringify({ kind: 'text', text: 'a' }), etag);
    await store.appendText!('Session', 'ws:s1', JSON.stringify({ kind: 'text', text: 'b' }), etag);
    await store.save('$sigx:tasks', 'Session\0ws:s1', { runs: {} }, null);
    const reminders = durableObjectReminders({ storage: state.storage, alarms: state.storage });
    const api = reminders.apiFor({ type: 'Session', key: 'ws:s1' });
    await api.set('sweep', { due: 60_000, period: 3_600_000 });
    await api.set('once', { due: 5_000 });
    return state;
}
