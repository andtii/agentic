/**
 * The shared actor test harness. Test-only: imported by `__tests__` through
 * a relative path, never from the package surface (it depends on
 * `@sigx/server/testing`, a devDependency).
 *
 * ```ts
 * const app = testActorApp([Workspace]);
 * beforeEach(() => app.start());
 * afterEach(() => app.stop());
 * const ws = app.as(userPrincipal('u1')).actor(Workspace, workspaceKey('u1'));
 * await ws.createAgent({ name: 'Ada' });
 * expect(app.saves.filter((s) => s.type === 'Workspace')).toHaveLength(1);
 * ```
 *
 * Identity: `as(principal)` binds one call context whose principal is
 * `principal` — the same in-process pipeline production runs (policies,
 * identity gate), with authentication short-circuited. `start()` also stamps
 * a JSON principal codec so `ctx.principal` reaches actor methods and
 * survives `ctx.actor()` hops; `stop()` restores the seam.
 */

import type { Principal } from '@agentic/core';
import { actor, type ActorClient, type AnyActorDefinition } from '@sigx/actors';
import { defineActorApp, memoryStorage, type ActorApp, type ActorAppOptions, type ActorStorage, type Host, type HostDefaults } from '@sigx/actors/host';
import { isServerFnError } from '@sigx/server';
import { createTestServerFnContext, stubServerApp } from '@sigx/server/testing';

export { memoryStorage };

/** One durable write the host made through the storage. */
export interface SaveRecord {
    readonly type: string;
    readonly key: string;
}

export type RecordingStorage = ActorStorage & { readonly saves: SaveRecord[] };

/** `memoryStorage()` that also records every `save`, so a test can count writes per actor. */
export function recordingStorage(inner: ActorStorage = memoryStorage()): RecordingStorage {
    const saves: SaveRecord[] = [];
    return {
        saves,
        load: (type, key) => inner.load(type, key),
        clear: (type, key, etag) => inner.clear(type, key, etag),
        save(type, key, state, etag) {
            saves.push({ type, key });
            return inner.save(type, key, state, etag);
        }
    };
}

/** Timers that never fire on their own; every test drives the host itself. */
export const QUIET_DEFAULTS: HostDefaults = { sweepIntervalMs: 600_000, reminderTickMs: 600_000, callTimeoutMs: 0 };

export interface TestActorAppOptions {
    readonly storage?: ActorStorage;
    readonly defaults?: HostDefaults;
    /** A `manualScheduler()` when the test drives reminder ticks itself. */
    readonly scheduler?: ActorAppOptions['scheduler'];
}

export interface PrincipalBinding {
    /** A client for `def`/`key` whose every call carries the bound principal. */
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClient<D>;
}

export interface TestActorApp {
    readonly app: ActorApp;
    readonly storage: ActorStorage;
    /** Every `save` the storage saw, in order (empty unless the storage is a `recordingStorage()`, the default). */
    readonly saves: readonly SaveRecord[];
    /** The running host; throws before `start()`. */
    readonly host: Host;
    start(): Promise<Host>;
    stop(): Promise<void>;
    as(principal: Principal | null): PrincipalBinding;
}

const codec = {
    encode: (principal: unknown) => JSON.stringify(principal),
    decode: (encoded: string) => (encoded === '' ? null : (JSON.parse(encoded) as unknown))
};

/** Build an app serving exactly `actors` over in-memory storage. */
export function testActorApp(actors: readonly AnyActorDefinition[], options: TestActorAppOptions = {}): TestActorApp {
    const storage = options.storage ?? recordingStorage();
    const saves = (storage as Partial<RecordingStorage>).saves ?? [];
    const app = defineActorApp({ actors, storage, ...(options.scheduler ? { scheduler: options.scheduler } : {}), defaults: { ...QUIET_DEFAULTS, ...options.defaults } });
    let restore: (() => void) | null = null;
    return {
        app,
        storage,
        saves,
        get host() {
            if (!app.host) throw new Error('[testActorApp] not started');
            return app.host;
        },
        async start() {
            restore ??= stubServerApp({ codec });
            return app.start();
        },
        async stop() {
            await app.stop({ timeoutMs: 1000 });
            restore?.();
            restore = null;
        },
        as(principal) {
            return {
                actor: (def, key) => actor(def, key).with({ context: createTestServerFnContext(undefined, { principal }) })
            };
        }
    };
}

/** A user principal owning workspace `userId` (v1: one workspace per user, `workspaceId === userId`). */
export function userPrincipal(userId: string): Principal {
    return { kind: 'user', userId, workspaceId: userId as Principal['workspaceId'] };
}

/** The HTTP status a rejected call carries, or `undefined` when the error is not a policy rejection. */
export function rejectionStatus(error: unknown): number | undefined {
    return isServerFnError(error) ? error.status : undefined;
}

/** Await `promise` and return its rejection status — `undefined` when it resolved. */
export async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
    try {
        await promise;
        return undefined;
    } catch (error) {
        return rejectionStatus(error);
    }
}
