/**
 * The transport every page installs (#713, #715): calls and streams as POSTs on the actor HTTP mount
 * (`fetchTransport`), live reads on one hibernatable socket per actor (`liveOverSockets`). The composed transport
 * always has a `live()` channel, so the actors plugin never falls back to the NDJSON `$live` stream — the one that kept
 * an object awake for as long as a tab was open (#351). There is no `$live` fallback where `WebSocket` is missing:
 * `resilientConnect` treats a dial that throws as a failed attempt and retries it, and the reads still render their
 * first value as ordinary calls.
 */
import { fetchTransport, type ActorTransport } from '@sigx/actors/client';
import { ACTOR_ENDPOINT } from './client';
import { browserSocketFor, liveOverSockets, type SocketReport } from './live-socket';

export interface PageTransportOptions {
    /** What the connection pill hears from each socket (OPS-04). */
    readonly report?: SocketReport;
    /** The calls' `fetch`; default the global one. Injected by tests. */
    readonly fetch?: typeof globalThis.fetch;
    /** One actor's socket transport; default `browserSocketFor(type, key, report)`. Injected by tests. */
    readonly socketFor?: (type: string, key: string) => ActorTransport;
}

export function pageTransport({ report = {}, fetch, socketFor = (type, key) => browserSocketFor(type, key, report) }: PageTransportOptions = {}): ActorTransport {
    return liveOverSockets({ calls: fetchTransport({ endpoint: ACTOR_ENDPOINT, ...(fetch ? { fetch } : {}) }), socketFor });
}
