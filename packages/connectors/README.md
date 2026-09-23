# @agentic/connectors

Native connectors over [conduit](https://github.com/aigntiq/conduit) (#531; AGT-09, AST-09, PLG-01, PLG-04, PLG-07). Edge-safe: it depends on `@agentic/core`, `@aigntiq/conduit` (root entry only, never `/node`) and `@aigntiq/conduit-connectors`, and imports no `node:` module.

Design: `docs/architecture.md` §9, "connectors that sign in" (#536).

## API

| Export | What it does |
|---|---|
| `createConnectorEngine({ secret, accounts, transient, locks, clients, redirectUri, http? })` | `createConduit` with the stores and the OAuth client injected. Specs default to every connector of `@aigntiq/conduit-connectors`. |
| `conduitTools(engine, { id, connector, account, owner })` | One connected account as `{ tools, toolNames, close }`, the platform's `OpenedConnector` shape. |
| `clientFromSecrets(openSecret, pluginId)` | conduit's `ClientResolver` from the connector plugin's own `<pluginId>-client-id` / `<pluginId>-client-secret` secrets. |
| `connectorClientSecretNames(pluginId)` | those two names. Registry secret names are workspace-wide, so each conduit connector plugin names its own OAuth client (#548). |
| `CONNECTOR_ENGINE_SECRET` | `connector-engine-secret`: the Registry secret holding the workspace's engine `secret`. The app generates it on the first Connect (#533). One per workspace, shared by every conduit connector plugin on purpose: it signs state and keys the cipher of the workspace's one account store. |
| `gmailConnectorPlugin` | The Gmail `PluginManifest` (`kind: 'connector'`). |
| `conduitConnectorManifest(spec, { hosts })` | The same manifest for any conduit connector. |
| `pollGmail(engine, { account, owner, query?, cursor?, now, maxArrivals? })` | One poll of the Gmail trigger (#535): `{ kind: 'arrivals', arrivals, cursor }` or `{ kind: 'needs-reauth' }`. The caller persists the cursor. |
| `gmailArrivalText(arrival, connectorId)` | What an agent is told about one new message: From, Subject, snippet, id and the `<id>__get-message` tool. |

## Tools

- There is one tool per operation of kind `action` or `search`, named `<id>__<operation>` (`gmail__send-email`). `options` operations feed pickers and `trigger`s are delivered, so neither becomes a tool.
- The input schema is the spec's own, minus the `x-` UI hints. The description is the operation's label and description. conduit validates every call against the spec, including cross-field rules.
- Hints come from the spec, never from the operation's name (`operationAnnotations`):
  - `destructive: true` on the operation → `destructive`.
  - A `search` → `readOnly`.
  - An `action` whose request and every step use a literal `GET` / `HEAD` (the default method is `GET`) → `readOnly`.
  - Anything else gets no hint, which the platform rules on as `network`.
- A failed call throws `ConnectorToolError`. An account whose sign-in expired or was revoked (`needsReauth`) gives `code: 'needs_reauth'` and a message asking the agent to have the workspace owner reconnect it. The account still opens, so the agent learns why.

## Gmail manifest

- Secrets: `gmail-client-id` and `gmail-client-secret` (required), the owner's own Google OAuth client, and `connector-engine-secret` (not required), the workspace's engine secret. The platform generates it on the first Connect, so it never holds readiness back and the plugin page offers no field for it (#533).
- Permissions: `secret:gmail-client-id`, `secret:gmail-client-secret`, `secret:connector-engine-secret`, `network:gmail.googleapis.com`, `network:oauth2.googleapis.com` and `tools:gmail`.
- Capabilities: `operation:<id>` for every callable operation, and `trigger:new-email` — agentic runs it by polling (#535).

## The Gmail trigger (#535)

conduit 0.1 declares Gmail's `new-email` poll trigger but runs no triggers, and the spec has no history operation. `pollGmail` stands in: `search-messages` for `(<query>) after:<since − 600 s>` (the overlap covers Gmail's search-index lag; the first poll looks back 15 minutes), minus the ids the cursor says were delivered (at most 500), oldest first and at most 20 per poll (a capped poll keeps its window, so nothing is lost), then `get-message` per arrival for its headers. An account that needs reconnecting is a `needs-reauth` verdict; any other failure throws for the caller to retry. The platform side (the Schedule entry, one task per arrival, the pause) is `apps/web/src/connectors/trigger.ts`.
