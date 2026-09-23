/**
 * `connectorAccountStores(client)` — conduit's `AccountStore`, `TransientStore`
 * and `LockProvider` over a client of the ConnectorAccounts actor (#532), for
 * `createConnectorEngine({ accounts, transient, locks, … })` (#531, #533).
 *
 * The client is whatever calls the actor under the right principal: the
 * owner's on the OAuth routes, a session's agent principal when a tool call
 * refreshes a token. Each port method is one actor call; `withLock` is two —
 * `lock` before `fn`, `unlock` after it, whatever `fn` did.
 */

import type { AccountFilter, AccountStore, LockProvider, StoredAccount, TransientStore } from '@aigntiq/conduit';
import type { LockGrant, LockOptions } from './types.js';

/** The slice of a ConnectorAccounts client the stores call (`ActorClient<typeof ConnectorAccounts>` satisfies it). */
export interface ConnectorAccountsClient {
    getAccount(id: string): Promise<StoredAccount | null>;
    listAccounts(filter?: AccountFilter): Promise<StoredAccount[]>;
    createAccount(account: StoredAccount): Promise<void>;
    updateAccount(account: StoredAccount, expectedVersion: number): Promise<boolean>;
    deleteAccount(id: string): Promise<boolean>;
    putTransient(key: string, value: string, ttlMs: number): Promise<void>;
    takeTransient(key: string): Promise<string | null>;
    lock(key: string, opts?: LockOptions): Promise<LockGrant>;
    unlock(key: string, token: string): Promise<boolean>;
}

export interface ConnectorAccountStores {
    readonly accounts: AccountStore;
    readonly transient: TransientStore;
    readonly locks: LockProvider;
}

export function connectorAccountStores(client: ConnectorAccountsClient, lockOptions: LockOptions = {}): ConnectorAccountStores {
    return {
        accounts: {
            get: async (id) => (await client.getAccount(id)) ?? undefined,
            list: (filter) => client.listAccounts(filter ?? {}),
            create: (account) => client.createAccount(account),
            update: (account, expectedVersion) => client.updateAccount(account, expectedVersion),
            delete: (id) => client.deleteAccount(id)
        },
        transient: {
            put: (key, value, ttlMs) => client.putTransient(key, value, ttlMs),
            take: async (key) => (await client.takeTransient(key)) ?? undefined
        },
        locks: {
            async withLock(key, fn) {
                const grant = await client.lock(key, lockOptions);
                try {
                    return await fn();
                } finally {
                    try {
                        await client.unlock(key, grant.token);
                    } catch {
                        // Unreachable actor: the lease lapses on its own, and CAS on `version` covers the gap.
                    }
                }
            }
        }
    };
}
