/**
 * Minimal in-process harness for actor tests: one host over `memoryStorage`,
 * a stubbed server app whose `authenticate` returns the principal under
 * test. `@sigx/actors/host` stamps the ambient host on `start()`, so the
 * plain `actor()` client (the same call sites production uses) dispatches
 * in-process with `authorize` running against that principal.
 *
 * The `codec` is what carries the principal INTO the turn (`ctx.principal`,
 * rfc-server-v4 §7): without one a policy still sees the caller but the
 * actor sees `null`. `Principal` is a plain object, so JSON is the codec —
 * the same one the web app configures on its `createServerApp`.
 */
import type { AnyActorDefinition, ActorStorage, Host } from '@sigx/actors';
import { defineActorApp, memoryStorage, type ActorApp } from '@sigx/actors/host';
import { stubServerApp } from '@sigx/server/testing';
import type { Principal, WorkspaceId } from '@agentic/core';

/** No background sweeps, no call deadlines — deterministic turns. */
const quiet = { sweepIntervalMs: 60_000, reminderTickMs: 60_000, callTimeoutMs: 0 };

export const WS = 'ws_test' as WorkspaceId;
export const OTHER_WS = 'ws_other' as WorkspaceId;

export const alice: Principal = { kind: 'user', userId: 'alice', workspaceId: WS };

export interface Harness {
    readonly app: ActorApp;
    readonly host: Host;
    readonly storage: ActorStorage;
    /** Swap the authenticated principal for the calls that follow. */
    signIn(principal: Principal | null): void;
    stop(): Promise<void>;
}

export async function startHarness(
    actors: readonly AnyActorDefinition[],
    options: { principal?: Principal | null; storage?: ActorStorage } = {}
): Promise<Harness> {
    let principal: Principal | null = options.principal === undefined ? alice : options.principal;
    const restore = stubServerApp({
        authenticate: () => principal,
        codec: { encode: (p) => JSON.stringify(p), decode: (s) => JSON.parse(s) as unknown }
    });
    const storage = options.storage ?? memoryStorage();
    const app = defineActorApp({ actors, storage, defaults: quiet });
    const host = await app.start();
    return {
        app,
        host,
        storage,
        signIn: (p) => {
            principal = p;
        },
        stop: async () => {
            await app.stop({ timeoutMs: 1000 });
            restore();
        }
    };
}
