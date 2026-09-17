/**
 * The Cloudflare bindings of the Workspace's OPS-10 ports (issue #100,
 * `docs/retention.md`):
 *
 * - `r2ArtifactSink` — `exportAll` writes to the `ARTIFACTS` R2 bucket.
 * - `durableObjectWorkspaceStore` — `deleteAll` purges a record by asking
 *   the actor's own Durable Object to do it: every actor is one object, so
 *   only that object can deactivate its live activation and clear its
 *   storage (record, task ledger, reminder shards) and alarm. There is no
 *   `list`: a namespace cannot be enumerated, so records the Workspace
 *   index does not reach (tasks, sessions, ledger months, audit) stay
 *   behind, as the retention doc says.
 * - `createPurgeHandler` — the object half, at `PURGE_PATH`. The Worker
 *   never forwards that path (its mount owns `/_sigx/*` and the daemon
 *   prefix only); the request must also carry `SESSION_SECRET`, so nothing
 *   outside this deployment can purge. Without the secret every purge is
 *   refused and `deleteAll` records the error instead of deleting.
 */
import type { ActorRecordRef, ArtifactSink, WorkspaceStore } from '@agentic/platform';
import type { Host } from '@sigx/actors';
import { durableObjectStubResolver, type DurableObjectNamespaceLike, type DurableObjectStateLike } from '@sigx/actors-cloudflare';

export const PURGE_PATH = '/_agentic/purge';
export const PURGE_HEADER = 'x-agentic-purge';

/** The slice of an R2 bucket the sink needs. */
export interface R2BucketLike {
    put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export function r2ArtifactSink(bucket: () => R2BucketLike | undefined): ArtifactSink {
    return {
        async put(path, body, options) {
            const b = bucket();
            if (!b) throw new Error('[retention] no ARTIFACTS bucket bound: exports cannot be written');
            await b.put(path, body, options?.contentType ? { httpMetadata: { contentType: options.contentType } } : undefined);
        }
    };
}

export interface DurableObjectStoreOptions {
    readonly namespace: () => DurableObjectNamespaceLike | undefined;
    readonly secret: () => string | undefined;
}

export function durableObjectWorkspaceStore(options: DurableObjectStoreOptions): WorkspaceStore {
    return {
        async purge(ref: ActorRecordRef) {
            const namespace = options.namespace();
            const secret = options.secret();
            if (!namespace || !secret) throw new Error('[retention] purge needs the ACTORS binding and SESSION_SECRET');
            const res = await durableObjectStubResolver({ namespace })
                .stub({ type: ref.type, key: ref.key })
                .fetch(`https://actor-host${PURGE_PATH}`, { method: 'POST', headers: { [PURGE_HEADER]: secret } });
            if (!res.ok) throw new Error(`[retention] purge ${ref.type} ${ref.key} failed: ${res.status} ${await res.text()}`);
        }
    };
}

/** What a real `DurableObjectStorage` has beyond the host's narrow slice. */
interface PurgeableStorage {
    deleteAll(): Promise<void>;
    deleteAlarm?(): Promise<void>;
}

export interface PurgeHandlerOptions {
    readonly state: DurableObjectStateLike;
    readonly host: () => Promise<Host>;
    /** This object's actor, from its id's name (`actorKeyOfObject`). */
    readonly own: { type: string; key: string } | null;
    readonly secret: () => string | undefined;
}

/** Same amount of work whatever the first mismatch is. */
function sameSecret(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function createPurgeHandler(options: PurgeHandlerOptions): { fetch(request: Request): Promise<Response> | null } {
    return {
        fetch(request) {
            if (new URL(request.url).pathname !== PURGE_PATH) return null;
            return (async () => {
                const secret = options.secret();
                const given = request.headers.get(PURGE_HEADER);
                if (request.method !== 'POST' || !secret || !given || !sameSecret(given, secret)) return new Response('forbidden', { status: 403 });
                if (!options.own) return new Response('not an actor object', { status: 400 });
                // Deactivate first, so nothing re-saves; then the whole object's storage and its alarm.
                await (await options.host()).deactivate(options.own, 'explicit');
                const storage = options.state.storage as unknown as PurgeableStorage;
                await storage.deleteAll();
                await storage.deleteAlarm?.();
                return new Response(null, { status: 204 });
            })();
        }
    };
}
