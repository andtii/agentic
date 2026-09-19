import { SELF } from 'cloudflare:test';
import type { WorkspaceId } from '@agentic/core';
import { REGISTRY_TYPE, registryKey, sealSession, sessionCookie, type RegistryActor } from '@agentic/platform';
import { ANTHROPIC_API_KEY_SECRET } from '@agentic/runtimes';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';

/** Paths of every request that reached the Worker. */
export const seen: string[] = [];

/** A `__Host-session` cookie header value for `userId` (v1: workspace id = user id). */
export async function signIn(userId: string): Promise<string> {
    return sessionCookie(await sealSession({ userId, workspaceId: userId as WorkspaceId }, TEST_SESSION_SECRET)).split(';')[0]!;
}

/**
 * An actor client that ONLY speaks HTTP to the Worker's mount — the same
 * wire the browser client uses (`{type}#{method}`, args `[key, ...args]`).
 */
export function overHttp<D extends AnyActorDefinition>(def: D, key: string, cookie: string | null): ActorClient<D> {
    const transport = fetchTransport({
        endpoint: `${ORIGIN}/_sigx/actor`,
        headers: cookie ? { cookie, origin: ORIGIN } : { origin: ORIGIN },
        fetch: (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            seen.push(new URL(url).pathname);
            return SELF.fetch(url, init);
        }
    });
    const type = (def as unknown as { type: string }).type;
    return new Proxy({} as ActorClient<D>, {
        get: (_target, method) => (typeof method === 'string' ? (...args: unknown[]) => transport.call(`${type}#${method}`, [key, ...args], { ref: { type, key } }) : undefined)
    });
}

/** The workspace's Registry over HTTP, as the plugin pages call it (#231). */
export const registryOverHttp = (workspaceId: WorkspaceId, cookie: string | null): ActorClient<RegistryActor> => overHttp({ type: REGISTRY_TYPE } as unknown as RegistryActor, registryKey(workspaceId), cookie);

/** What a user does once at `/plugins/anthropic-api` before an `anthropic-api` agent can answer (#231): store the workspace's key. */
export async function setAnthropicKey(workspaceId: WorkspaceId, cookie: string, key = 'sk-ant-workers-test'): Promise<void> {
    await registryOverHttp(workspaceId, cookie).setSecret(ANTHROPIC_API_KEY_SECRET, key);
}
