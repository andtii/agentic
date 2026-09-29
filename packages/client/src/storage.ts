/**
 * A small synchronous key-value store for the app stores' persisted bits
 * (a pinned view, a collapsed panel). DOM-free by contract: the web shell
 * provides it over `localStorage` (guarded for SSR), the Lynx shell over
 * `lynx-storage`, tests over `memoryKeyValueStorage()`.
 */
import { defineInjectable } from '@sigx/runtime-core';

export interface KeyValueStorage {
    /** The stored string, or `null` when absent or unreadable. */
    get(key: string): string | null;
    /** Store a string; a failure (quota, private mode) is swallowed. */
    set(key: string, value: string): void;
    remove(key: string): void;
}

export const useKeyValueStorage = defineInjectable<KeyValueStorage>('KeyValueStorage', { hint: 'app.defineProvide(useKeyValueStorage, () => storage) in the shell (the web: apps/web/src/actors/storage.ts).' });

/** An in-memory `KeyValueStorage` — for tests and for a host with nowhere to persist. */
export function memoryKeyValueStorage(seed: Record<string, string> = {}): KeyValueStorage {
    const map = new Map(Object.entries(seed));
    return {
        get: (key) => map.get(key) ?? null,
        set: (key, value) => void map.set(key, value),
        remove: (key) => void map.delete(key)
    };
}
