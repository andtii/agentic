/**
 * Web-only app stores (#1124): the state the shell and a page share — a page's head for the topbar, a request the
 * topbar's button raises and the page's dialog answers. Each is a `@sigx/store` singleton, one instance per
 * AppContext: every SSR request builds a fresh app, so one request's head never reaches another's render (as the
 * module-level signals they replace could).
 *
 * A component reads its store in setup (`useX()`) and keeps the instance for its watchers and handlers; a function
 * the shell calls while it renders (a topbar contribution) resolves it there. Code outside any component — a click
 * handler, a test — has no app to resolve through: in the browser it gets the store of the app last seen there (a
 * browser runs one app); on the server it gets a detached instance, so server code never writes a store outside a
 * component.
 */
import { useAppContext } from 'sigx';
import { defineStore } from '@sigx/store';

const CLIENT = typeof document !== 'undefined';

/** Define a web store: `defineStore(name, setup, 'singleton')`, resolved as above. No live reads here — those belong in `@agentic/client`. */
export function defineWebStore<T extends object>(name: string, setup: () => T): () => T {
    const use = defineStore<T>(name, () => setup(), 'singleton') as unknown as () => T;
    let latest: T | null = null;
    return () => {
        if (useAppContext()) {
            const store = use();
            if (CLIENT) latest = store;
            return store;
        }
        return CLIENT && latest ? latest : use();
    };
}

/**
 * An object that reads and writes through to `target()` on every access — how a module keeps exporting
 * `chatHead` / `newChatRequest` while the state behind it lives in a store.
 */
export function forward<T extends object>(target: () => T): T {
    return new Proxy({} as T, {
        get: (_, key) => Reflect.get(target(), key),
        set: (_, key, value) => Reflect.set(target(), key, value),
        has: (_, key) => Reflect.has(target(), key),
        ownKeys: () => Reflect.ownKeys(target()),
        getOwnPropertyDescriptor: (_, key) => {
            const d = Reflect.getOwnPropertyDescriptor(target(), key);
            return d ? { ...d, configurable: true } : undefined;
        }
    });
}
