/**
 * The ConnectorAccounts actor — `{ws}:connector-accounts` (architecture §9
 * "connectors that sign in"; #532; USR-01, EXE-10, OPS-01, OPS-03).
 *
 * The workspace's side of conduit's three storage ports, so connected
 * accounts, OAuth handshakes and token refreshes survive Worker eviction and
 * stay inside the workspace. `connectorAccountStores(client)` turns a client
 * of this actor into conduit's `AccountStore`, `TransientStore` and
 * `LockProvider`.
 *
 * - **Accounts** are conduit's `StoredAccount`, by id. `credentials` is the
 *   string conduit's `SecretCipher` sealed: the actor never sees a token, and
 *   refuses a credentials string that is plain JSON (what conduit seals is
 *   `JSON.stringify(credentials)`, so an unsealed write would look like one).
 *   `updateAccount` compare-and-sets on `version`: false on a mismatch or a
 *   missing account, never a throw.
 * - **Transients** (OAuth state, PKCE verifiers) carry a TTL; `takeTransient`
 *   reads and deletes, and an expired value reads as `null`. Every write
 *   prunes what has expired.
 * - **Locks** (`lock` / `unlock`) serialize per key, first come first served.
 *   The critical section — conduit's refresh — runs in the Worker, not here:
 *   a function cannot cross the actor boundary, so the lock is a LEASE the
 *   caller holds between two calls. The Durable Object runs one turn at a
 *   time, but `lock` must wait for an `unlock` that arrives as another call,
 *   so both are interleaved (`methodReentrancy: 'always'`) and touch only an
 *   in-memory table: a waiting `lock` never blocks the account writes.
 *   The table is not state and is never saved — a lock is worth nothing
 *   once its holder is gone. What keeps racing refreshes safe is not the lock
 *   alone but compare-and-set on `version`: the lock makes a second refresh
 *   RARE (it waits, then re-reads and finds the renewed account), and CAS
 *   makes it HARMLESS when the lock was lost anyway — a lease that lapsed
 *   under a slow refresh fetch, or a Durable Object evicted with no waiter
 *   left to keep it alive. Two refreshes then both read version n; the first
 *   `updateAccount(next, n)` wins, the second gets `false` and conduit reads
 *   the winner back instead of overwriting it. A `needsReauth` mark is a CAS
 *   write too, so a late failure cannot flag an account a sibling has just
 *   renewed.
 *
 * Policy: every call must come from the workspace (`sameWorkspace`). Anything
 * that returns or writes sealed credentials or transients — every conduit
 * port method, and the locks — is the owner's (a user principal: the page,
 * the OAuth callback) or an agent principal's (a session refreshing a token
 * mid-call). A machine or an external client may read `accounts()` and
 * `exportRows()`, which carry no credentials, and nothing else.
 *
 * Audit (OPS-03): `connector.connected` when an account is created or comes
 * back from `needsReauth`, `connector.needs-reauth` when one drops into it,
 * `connector.disconnected` when one is deleted. Refreshes are not recorded.
 *
 * Every mutation ends in `ctx.save()` inside the turn (Workers eviction rule).
 */

import type { Principal, WorkspaceId } from '@agentic/core';
import type { AccountFilter, StoredAccount } from '@aigntiq/conduit';
import { defineActor, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { principalLabel } from '../agent/index.js';
import type { AuditEventInput } from '../audit/events.js';
import { recordAudit } from '../audit/port.js';
import { sameWorkspace } from '../auth/index.js';
import { parseConnectorAccountsKey } from './key.js';
import {
    CONNECTOR_ACCOUNTS_STATE_VERSION,
    type ConnectorAccountSummary,
    type ConnectorAccountsExportRow,
    type ConnectorAccountsState,
    type LockGrant,
    type LockOptions
} from './types.js';

export interface ConnectorAccountsOptions {
    readonly now?: () => number;
    /** Override the policy chain. Default: the package's `sameWorkspace`. */
    readonly authorize?: ActorPolicy | readonly ActorPolicy[];
    /** Most transients a workspace holds at once, expired ones pruned first. Default 1000. */
    readonly maxTransient?: number;
}

export const DEFAULT_LOCK_LEASE_MS = 60_000;
export const DEFAULT_LOCK_WAIT_MS = 20_000;

/** The owner, or an agent principal minted for a session (a refresh mid-call). */
const ownerOrAgent: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user' || principal?.kind === 'agent';

const MAX_ID = 512;
const MAX_VALUE = 16_384;
const STATUSES: ReadonlySet<string> = new Set(['active', 'needsReauth']);

export function initialConnectorAccountsState(): ConnectorAccountsState {
    return { v: CONNECTOR_ACCOUNTS_STATE_VERSION, accounts: {}, transient: {} };
}

const bad = (message: string): ServerFnError => new ServerFnError(400, `[connector-accounts] ${message}`);

function assertId(value: unknown, what: string): asserts value is string {
    // `__proto__` would set the record's prototype instead of a key.
    if (typeof value !== 'string' || value === '' || value.length > MAX_ID || value === '__proto__') throw bad(`${what} must be a non-empty string of at most ${MAX_ID} characters`);
}

/** What conduit seals is `JSON.stringify(credentials)`: a JSON object or array here is a credential that was never sealed. */
function looksUnsealed(credentials: string): boolean {
    const t = credentials.trimStart();
    return t.startsWith('{') || t.startsWith('[');
}

function assertAccount(account: unknown): asserts account is StoredAccount {
    if (!account || typeof account !== 'object' || Array.isArray(account)) throw bad('an account must be an object');
    const a = account as Partial<StoredAccount>;
    assertId(a.id, 'account id');
    for (const field of ['owner', 'connector', 'method'] as const) {
        if (typeof a[field] !== 'string' || a[field] === '') throw bad(`account "${a.id}" needs a ${field}`);
    }
    if (typeof a.status !== 'string' || !STATUSES.has(a.status)) throw bad(`account "${a.id}" has an unknown status ${String(a.status)}`);
    if (typeof a.credentials !== 'string' || a.credentials === '') throw bad(`account "${a.id}" needs sealed credentials`);
    if (looksUnsealed(a.credentials)) throw bad(`account "${a.id}": credentials must be sealed by conduit's cipher, never plaintext`);
    for (const field of ['version', 'createdAt', 'updatedAt'] as const) {
        if (typeof a[field] !== 'number' || !Number.isFinite(a[field])) throw bad(`account "${a.id}" needs a numeric ${field}`);
    }
    if (a.expiresAt !== undefined && (typeof a.expiresAt !== 'number' || !Number.isFinite(a.expiresAt))) throw bad(`account "${a.id}": expiresAt must be a number`);
    if (a.data !== undefined && (a.data === null || typeof a.data !== 'object' || Array.isArray(a.data))) throw bad(`account "${a.id}": data must be an object`);
}

const summaryOf = (a: StoredAccount): ConnectorAccountSummary => ({
    id: a.id,
    connector: a.connector,
    method: a.method,
    status: a.status,
    ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
    ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
});

/** One key's lock: who holds it until when, and who queues for it, in arrival order. */
interface LockSlot {
    holder?: { readonly token: string; readonly until: number; readonly timer: ReturnType<typeof setTimeout> };
    readonly waiters: Array<{ readonly grant: () => void; readonly timer: ReturnType<typeof setTimeout> }>;
}

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

export function defineConnectorAccounts(options: ConnectorAccountsOptions = {}) {
    const now = options.now ?? (() => Date.now());
    const authorize: ActorPolicy | readonly ActorPolicy[] = options.authorize ?? sameWorkspace;
    const maxTransient = options.maxTransient ?? 1000;

    /**
     * Lock tables by actor key. In memory, per isolate: a Durable Object owns one key, and the in-process host
     * shares an isolate across keys. Empty slots are dropped, so the map holds only locks in use.
     */
    const lockTables = new Map<string, Map<string, LockSlot>>();

    type Ctx = ActorContext<ConnectorAccountsState>;

    const workspaceOf = (ctx: Ctx): WorkspaceId => {
        const ws = parseConnectorAccountsKey(ctx.key);
        if (ws === null) throw new Error(`[connector-accounts] key must be "{ws}:connector-accounts", got "${ctx.key}"`);
        return ws;
    };

    const audit = (ctx: Ctx, event: AuditEventInput): Promise<void> => recordAudit(ctx, workspaceOf(ctx), event);

    const auditAccount = (ctx: Ctx, kind: 'connector.connected' | 'connector.disconnected' | 'connector.needs-reauth', a: StoredAccount, at: number, extra: { reconnected?: boolean } = {}): Promise<void> => {
        const what = { 'connector.connected': extra.reconnected ? 'reconnected' : 'connected', 'connector.disconnected': 'disconnected', 'connector.needs-reauth': 'needs to be reconnected' }[kind];
        return audit(ctx, {
            key: `${ctx.key}:${a.id}:${kind}:${a.version}:${at}`,
            kind,
            at,
            by: principalLabel(ctx.principal),
            summary: `${a.connector} account ${a.displayName ?? a.id} ${what}`,
            data: { accountId: a.id, connector: a.connector, method: a.method, ...(a.displayName !== undefined ? { displayName: a.displayName } : {}), ...(extra.reconnected ? { reconnected: true } : {}) }
        });
    };

    /** Drop every expired transient. The caller saves. */
    const prune = (ctx: Ctx): void => {
        const t = now();
        for (const [key, row] of Object.entries(ctx.state.transient)) if (row.expiresAt <= t) delete ctx.state.transient[key];
    };

    const locksOf = (ctx: Ctx): Map<string, LockSlot> => {
        let table = lockTables.get(ctx.key);
        if (!table) lockTables.set(ctx.key, (table = new Map()));
        return table;
    };

    /** Hand the lock to the next waiter, or drop the slot when nobody waits. */
    const release = (ctx: Ctx, key: string): void => {
        const table = locksOf(ctx);
        const slot = table.get(key);
        if (!slot) return;
        if (slot.holder) clearTimeout(slot.holder.timer);
        slot.holder = undefined;
        const next = slot.waiters.shift();
        if (next) {
            clearTimeout(next.timer);
            next.grant();
        } else {
            table.delete(key);
            if (table.size === 0) lockTables.delete(ctx.key);
        }
    };

    /** Make the caller the holder of `slot` for `leaseMs`; the lease lapses on its own if it never unlocks. */
    const hold = (ctx: Ctx, key: string, slot: LockSlot, leaseMs: number): LockGrant => {
        const token = crypto.randomUUID();
        const until = now() + leaseMs;
        const timer = setTimeout(() => {
            if (slot.holder?.token === token) release(ctx, key);
        }, leaseMs);
        slot.holder = { token, until, timer };
        return { token, until };
    };

    return defineActor({
        type: 'ConnectorAccounts',
        authorize,
        methodAuthorize: {
            getAccount: [ownerOrAgent],
            listAccounts: [ownerOrAgent],
            createAccount: [ownerOrAgent],
            updateAccount: [ownerOrAgent],
            deleteAccount: [ownerOrAgent],
            putTransient: [ownerOrAgent],
            takeTransient: [ownerOrAgent],
            lock: [ownerOrAgent],
            unlock: [ownerOrAgent]
        },
        persistence: 'explicit',
        reads: { accounts: { maxAge: 0 } },
        // `lock` waits for an `unlock` that arrives as another call: both must interleave (see the header).
        methodReentrancy: { lock: 'always', unlock: 'always' },
        state: (): ConnectorAccountsState => initialConnectorAccountsState(),
        methods: (ctx) => ({
            // -- AccountStore -------------------------------------------------

            async getAccount(id: string): Promise<StoredAccount | null> {
                const a = Object.hasOwn(ctx.state.accounts, id) ? ctx.state.accounts[id] : undefined;
                return a ? ctx.snapshot(a) : null;
            },

            async listAccounts(filter: AccountFilter = {}): Promise<StoredAccount[]> {
                return Object.keys(ctx.state.accounts)
                    .sort()
                    .map((id) => ctx.state.accounts[id]!)
                    .filter((a) => (filter.owner === undefined || a.owner === filter.owner) && (filter.connector === undefined || a.connector === filter.connector))
                    .map((a) => ctx.snapshot(a));
            },

            /** Insert. 409 when the id exists. Audited as `connector.connected`. */
            async createAccount(account: StoredAccount): Promise<void> {
                assertAccount(account);
                if (Object.hasOwn(ctx.state.accounts, account.id)) throw new ServerFnError(409, `[connector-accounts] account "${account.id}" already exists`);
                const stored = ctx.snapshot(account);
                ctx.state.accounts[account.id] = stored;
                await ctx.save();
                await auditAccount(ctx, 'connector.connected', stored, now());
            },

            /**
             * Replace iff the stored `version` is `expectedVersion` (compare-and-set). False on a mismatch or a
             * missing account, never a throw. A move into or out of `needsReauth` is audited.
             */
            async updateAccount(account: StoredAccount, expectedVersion: number): Promise<boolean> {
                assertAccount(account);
                const current = Object.hasOwn(ctx.state.accounts, account.id) ? ctx.state.accounts[account.id] : undefined;
                if (!current || current.version !== expectedVersion) return false;
                const stored = ctx.snapshot(account);
                ctx.state.accounts[account.id] = stored;
                await ctx.save();
                if (current.status !== stored.status) {
                    const at = now();
                    if (stored.status === 'needsReauth') await auditAccount(ctx, 'connector.needs-reauth', stored, at);
                    else await auditAccount(ctx, 'connector.connected', stored, at, { reconnected: true });
                }
                return true;
            },

            /** Audited as `connector.disconnected` when there was an account to delete. */
            async deleteAccount(id: string): Promise<boolean> {
                const current = Object.hasOwn(ctx.state.accounts, id) ? ctx.state.accounts[id] : undefined;
                if (!current) return false;
                delete ctx.state.accounts[id];
                await ctx.save();
                await auditAccount(ctx, 'connector.disconnected', current, now());
                return true;
            },

            // -- TransientStore -----------------------------------------------

            async putTransient(key: string, value: string, ttlMs: number): Promise<void> {
                assertId(key, 'transient key');
                if (typeof value !== 'string' || value.length > MAX_VALUE) throw bad(`a transient value must be a string of at most ${MAX_VALUE} characters`);
                if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) throw bad('a transient needs a finite ttl');
                prune(ctx);
                if (!Object.hasOwn(ctx.state.transient, key) && Object.keys(ctx.state.transient).length >= maxTransient) {
                    throw new ServerFnError(429, `[connector-accounts] too many sign-ins in flight (${maxTransient}); try again shortly`);
                }
                ctx.state.transient[key] = { value, expiresAt: now() + ttlMs };
                await ctx.save();
            },

            /** Read AND delete. An expired or missing value reads as `null`. */
            async takeTransient(key: string): Promise<string | null> {
                if (typeof key !== 'string' || !Object.hasOwn(ctx.state.transient, key)) return null;
                const row = ctx.state.transient[key]!;
                delete ctx.state.transient[key];
                prune(ctx);
                await ctx.save();
                return row.expiresAt > now() ? row.value : null;
            },

            // -- LockProvider -------------------------------------------------

            /**
             * Wait for the lock on `key`, first come first served, and hold it for a lease. 423 when `waitMs`
             * passes first. In memory only: nothing here is state, so nothing is saved.
             */
            lock(key: string, opts: LockOptions = {}): Promise<LockGrant> {
                assertId(key, 'lock key');
                const leaseMs = positive(opts.leaseMs, DEFAULT_LOCK_LEASE_MS);
                const waitMs = positive(opts.waitMs, DEFAULT_LOCK_WAIT_MS);
                const table = locksOf(ctx);
                let slot = table.get(key);
                if (!slot) table.set(key, (slot = { waiters: [] }));
                if (!slot.holder && slot.waiters.length === 0) return Promise.resolve(hold(ctx, key, slot, leaseMs));
                const s = slot;
                return new Promise<LockGrant>((resolve, reject) => {
                    const waiter = {
                        grant: () => resolve(hold(ctx, key, s, leaseMs)),
                        timer: setTimeout(() => {
                            const i = s.waiters.indexOf(waiter);
                            if (i !== -1) s.waiters.splice(i, 1);
                            reject(new ServerFnError(423, `[connector-accounts] the lock "${key}" stayed held for ${waitMs} ms`));
                        }, waitMs)
                    };
                    s.waiters.push(waiter);
                });
            },

            /** Release a grant. False when `token` no longer holds the lock (its lease lapsed). */
            unlock(key: string, token: string): boolean {
                const slot = locksOf(ctx).get(key);
                if (!slot?.holder || slot.holder.token !== token) return false;
                release(ctx, key);
                return true;
            },

            // -- views ----------------------------------------------------------

            /** Every account without credentials or data, id order — what the connector pages read. */
            accounts(): ConnectorAccountSummary[] {
                return Object.keys(ctx.state.accounts)
                    .sort()
                    .map((id) => summaryOf(ctx.state.accounts[id]!));
            },

            /** NDJSON rows for `Workspace.exportAll`: id, connector, status and display name — never credentials. */
            async exportRows(): Promise<ConnectorAccountsExportRow[]> {
                return Object.keys(ctx.state.accounts)
                    .sort()
                    .map((id) => {
                        const a = ctx.state.accounts[id]!;
                        return { kind: 'connector-account', account: { id: a.id, connector: a.connector, status: a.status, ...(a.displayName !== undefined ? { displayName: a.displayName } : {}) } };
                    });
            }
        })
    });
}

/** The default definition — what the app registers, and a hop target. */
export const ConnectorAccounts = defineConnectorAccounts();

export type ConnectorAccountsActor = ReturnType<typeof defineConnectorAccounts>;
