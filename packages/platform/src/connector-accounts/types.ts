/** ConnectorAccounts state and views (#532). The account shape is conduit's own `StoredAccount`. */

import type { AccountStatus, StoredAccount } from '@aigntiq/conduit';

export type { AccountFilter, AccountStatus, StoredAccount } from '@aigntiq/conduit';

export const CONNECTOR_ACCOUNTS_STATE_VERSION = 1;

/** A short-lived, single-use value (OAuth state, a PKCE verifier) and when it lapses (epoch ms). */
export interface TransientRecord {
    value: string;
    expiresAt: number;
}

export interface ConnectorAccountsState {
    v: number;
    /** By account id. `credentials` is conduit's SEALED string — never plaintext. */
    accounts: Record<string, StoredAccount>;
    /** By conduit's transient key. Expired entries are pruned on every write. */
    transient: Record<string, TransientRecord>;
}

/** What a page or an export sees of an account: never `credentials`, never `data`. */
export interface ConnectorAccountSummary {
    readonly id: string;
    readonly connector: string;
    readonly method: string;
    readonly status: AccountStatus;
    readonly displayName?: string;
    readonly expiresAt?: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** NDJSON rows for `Workspace.exportAll`: accounts by id, connector, status and display name — never credentials. */
export interface ConnectorAccountsExportRow {
    readonly kind: 'connector-account';
    readonly account: {
        readonly id: string;
        readonly connector: string;
        readonly status: AccountStatus;
        readonly displayName?: string;
    };
}

/** A lock `lock()` granted: present its token to `unlock()`. */
export interface LockGrant {
    readonly token: string;
    /** When the lease lapses on its own (epoch ms), should the holder never unlock. */
    readonly until: number;
}

export interface LockOptions {
    /** How long the grant holds before it lapses on its own. Default 60 s. */
    readonly leaseMs?: number;
    /** How long to queue for the lock before refusing (423). Default 20 s — under the host's call deadline. */
    readonly waitMs?: number;
}
