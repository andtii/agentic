/**
 * Per-object host scoping for `ActorHost` (#137).
 *
 * `@sigx/actors` keeps the current host in ONE global,
 * `globalThis.__SIGX_ACTOR_HOST__` (`seam.ts`: last `start()` wins), and
 * `createHostDurableObject` starts one host per Durable Object. In an isolate
 * holding several `ActorHost` objects — the workers test pool always,
 * production whenever objects of the class share an isolate — every ambient
 * `actor(def, key)` call therefore resolved through whichever object booted
 * LAST. That host's placement answers `isSelf(ref)` for ITS actor, so a hop
 * from object X to the actor object Y hosts ran Y's actor locally inside X's
 * context on Y's storage: "Cannot perform I/O on behalf of a different
 * Durable Object", Y reset, its in-flight turn lost.
 *
 * Until the seam scopes itself upstream (signalxjs/actors#456), the global is an
 * ACCESSOR here: a read inside a scope entered with `runWithHost` answers that
 * scope's host, a read outside any scope answers what `stampHost` last wrote —
 * so `@sigx/actors` keeps working unchanged, and every object's entry points
 * (`fetch`, the hibernation handlers, `alarm`) run under their own host. The
 * scope is an `AsyncLocalStorage` (workerd under `nodejs_compat`, which
 * `wrangler.jsonc` sets), so a background task an entry point starts — a
 * Session's drive, a save after the response — inherits the object it runs in.
 *
 * The store is a THUNK, not a host: the Worker enters its scope before its
 * lazily-booted host exists, and reads inside resolve to it once it does
 * (falling through to the stamped global until then).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Host } from '@sigx/actors';

const SEAM = '__SIGX_ACTOR_HOST__';

type HostSource = () => Host | undefined;

const scope = new AsyncLocalStorage<HostSource>();
/** What `stampHost` / `clearHost` wrote — the fallback outside any scope. */
let stamped: Host | undefined;

const read = (): Host | undefined => scope.getStore()?.() ?? stamped;

/**
 * Turn the seam into the accessor, keeping whatever a host already stamped.
 * Idempotent, and re-applied if the seam was reset to a data property —
 * `clearHost` (`host.stop()`) DELETES the property, which would otherwise
 * silently drop the scope for the isolate's remaining life.
 */
export function installHostScope(): void {
    const g = globalThis as Record<string, unknown>;
    const current = Object.getOwnPropertyDescriptor(g, SEAM);
    if (current?.get === read) return;
    // A data property carries a stamped host; no property at all means a `clearHost` ran.
    stamped = current && 'value' in current ? (current.value as Host | undefined) : undefined;
    Object.defineProperty(g, SEAM, {
        configurable: true,
        enumerable: false,
        get: read,
        set: (host: Host | undefined) => {
            stamped = host;
        }
    });
}

/** Run `fn` with every ambient `actor()` inside resolving through `host` (or the host `host()` answers at read time). */
export function runWithHost<T>(host: Host | HostSource, fn: () => T): T {
    installHostScope();
    return scope.run(typeof host === 'function' ? host : () => host, fn);
}

/** The host an ambient `actor()` would resolve through right now — a test seam. */
export function currentScopedHost(): Host | undefined {
    return read();
}
