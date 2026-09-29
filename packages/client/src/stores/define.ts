/**
 * App stores: `@sigx/store` singletons (one per AppContext — each SSR request
 * builds a fresh app, so requests stay isolated) created by the persistent
 * shell. A store's setup binds its `useActorState` / `useData` reads to the
 * component that first calls it (their `onMounted` / `onUnmounted` hooks go on
 * `getCurrentInstance()`), so `initAppStores()` — called at the top of the
 * shell's setup — creates every registered store first, and a store a page
 * creates first warns in dev: its reads would close with that page.
 */
import { defineStore, type SetupStoreContext, type UnwrapStore } from '@sigx/store';

/** The compile-time dev flag (`defineLibConfig` and vitest define it). Module-scoped so it never clashes with another package's global. */
declare const __DEV__: boolean;

const registry: (() => unknown)[] = [];
let initDepth = 0;

/** A store's name when a page created it before the shell did — what the dev assert says. */
export function outsideInitMessage(name: string): string {
    return `[@agentic/client] app store "${name}" was first created outside initAppStores(): its live reads bind to that component and close when it unmounts. Create it in the shell (initAppStores() in App's setup) before any page uses it.`;
}

/**
 * Define an app-lifetime store: `defineStore(name, setup, 'singleton')`, registered for `initAppStores()`.
 * The setup takes no arguments — a store derives its workspace from `useViewer()` and re-subscribes when it changes.
 * Put its own teardown (and any watcher it starts) in `ctx.onDeactivated`.
 */
export function defineAppStore<TReturn extends object>(name: string, setup: (ctx: SetupStoreContext) => TReturn): () => UnwrapStore<TReturn> {
    const use = defineStore<TReturn>(name, (ctx) => {
        if (__DEV__ && initDepth === 0) console.warn(outsideInitMessage(name));
        return setup(ctx);
    }, 'singleton');
    registry.push(use);
    return use;
}

/** Create every registered app store, bound to the calling component — the shell. Call it at the top of the shell's setup. */
export function initAppStores(): void {
    initDepth++;
    try {
        for (const use of registry) use();
    } finally {
        initDepth--;
    }
}
