/**
 * Elevation on the Machine page (#355): a security-sensitive change — the
 * folders the web may use, `bypassPermissions` on, revoking or removing the
 * machine — is refused by the platform with 403 `elevation-required: …` until
 * the user re-confirms through the login provider (`/auth/elevate`, a
 * ten-minute `__Host-elevated` cookie). The pure half of turning that refusal
 * into one extra click: recognise it, keep the pending change across the
 * round trip (per machine, in `sessionStorage`, for at most ten minutes), and
 * build the URL that comes back to this page. Nothing is replayed without the
 * user's click on return — `takePending` only hands the draft back.
 */
import { ELEVATION_REQUIRED, ELEVATION_TTL_MS } from '@agentic/core';

/** What was being done when elevation was asked for; the page dispatches on `kind` after the round trip. */
export const PENDING_KINDS = ['revoke', 'remove', 'policy', 'environment'] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];
const isPendingKind = (v: unknown): v is PendingKind => typeof v === 'string' && (PENDING_KINDS as readonly string[]).includes(v);

export interface PendingChange {
    readonly kind: PendingKind;
    /** The change as the dialog had it — a draft for `policy` / `environment`, nothing for `revoke` / `remove`. */
    readonly draft?: unknown;
    /** When it was put aside (ms epoch): older than an elevation lasts, it is dropped. */
    readonly at: number;
}

/** A thrown actor call that asks for elevation: 403 whose message STARTS with the platform's prefix (`elevation-required:`), like `requireElevated` writes it. */
export function isElevationRequired(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    return status === 403 && message.startsWith(`${ELEVATION_REQUIRED}:`);
}

export const pendingKey = (machineId: string): string => `agentic:elevate:${machineId}`;

/** Where to send the browser; `returnTo` is the page to come back to (same-origin path only, the route checks it too). */
export const elevateUrl = (returnTo: string): string => `/auth/elevate?returnTo=${encodeURIComponent(returnTo)}`;

/** A minimal `Storage`: `sessionStorage` in the browser, a map in tests. */
export interface PendingStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** The browser's `sessionStorage`, or `null` where there is none (SSR) or it throws (a hardened browser). */
export function browserPendingStore(): PendingStore | null {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
        return null;
    }
}

export function savePending(store: PendingStore | null, machineId: string, change: Omit<PendingChange, 'at'>, now: number = Date.now()): void {
    try {
        store?.setItem(pendingKey(machineId), JSON.stringify({ ...change, at: now }));
    } catch {
        // Storage refused: the user will redo the change by hand after the round trip.
    }
}

/** The change put aside for `machineId`, removed from the store as it is read; `null` when there is none or it is stale. */
export function takePending(store: PendingStore | null, machineId: string, now: number = Date.now()): PendingChange | null {
    if (!store) return null;
    const key = pendingKey(machineId);
    let raw: string | null;
    try {
        raw = store.getItem(key);
        store.removeItem(key);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<PendingChange>;
        // A kind this build does not know (a tampered or an older store) is nothing to resume.
        if (typeof parsed.at !== 'number' || !isPendingKind(parsed.kind)) return null;
        if (now - parsed.at > ELEVATION_TTL_MS) return null;
        return { kind: parsed.kind, ...(parsed.draft === undefined ? {} : { draft: parsed.draft }), at: parsed.at };
    } catch {
        return null;
    }
}

/** How the confirm reads for each kind. */
export function describePending(kind: PendingKind, machineName: string): { readonly what: string; readonly title: string; readonly description: string; readonly confirmLabel: string } {
    const what = kind === 'revoke' ? `revoke ${machineName}` : kind === 'remove' ? `remove ${machineName} from this workspace` : kind === 'policy' ? `change the folders the web may use on ${machineName}` : `change an environment on ${machineName}`;
    return {
        what,
        title: 'Confirm with GitHub to continue',
        description: `To ${what}, sign in with GitHub once more. You come straight back here and the change is applied with one click — a session cookie alone cannot make it.`,
        confirmLabel: 'Continue to GitHub'
    };
}
