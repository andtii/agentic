/** ConnectorAccounts actor: conduit's account, transient and lock stores per workspace (architecture §9 "connectors that sign in", #532). */

export { CONNECTOR_ACCOUNTS_TYPE, connectorAccountsKey, parseConnectorAccountsKey } from './key.js';
export {
    ConnectorAccounts,
    DEFAULT_LOCK_LEASE_MS,
    DEFAULT_LOCK_WAIT_MS,
    defineConnectorAccounts,
    initialConnectorAccountsState,
    type ConnectorAccountsActor,
    type ConnectorAccountsOptions
} from './actor.js';
export { connectorAccountStores, type ConnectorAccountStores, type ConnectorAccountsClient } from './stores.js';
export {
    CONNECTOR_ACCOUNTS_STATE_VERSION,
    type AccountFilter,
    type AccountStatus,
    type ConnectorAccountSummary,
    type ConnectorAccountsExportRow,
    type ConnectorAccountsState,
    type LockGrant,
    type LockOptions,
    type StoredAccount,
    type TransientRecord
} from './types.js';
