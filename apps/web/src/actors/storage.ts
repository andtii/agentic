/**
 * The web's `KeyValueStorage` (#1116): `localStorage`, guarded — on the server
 * (SSR) and where the browser refuses it (private mode, blocked site data) a
 * read is `null` and a write is dropped.
 */
import type { KeyValueStorage } from '@agentic/client';

const store = (): Storage | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
};

export const webKeyValueStorage: KeyValueStorage = {
    get(key) {
        try {
            return store()?.getItem(key) ?? null;
        } catch {
            return null;
        }
    },
    set(key, value) {
        try {
            store()?.setItem(key, value);
        } catch {
            // quota or private mode: the value just is not kept
        }
    },
    remove(key) {
        try {
            store()?.removeItem(key);
        } catch {
            // as above
        }
    }
};
