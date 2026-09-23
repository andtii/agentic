# @agentic/connectors

Native connectors over [conduit](https://github.com/aigntiq/conduit) (#531; AGT-09, AST-09, PLG-01, PLG-04, PLG-07). Edge-safe: it depends on `@agentic/core`, `@aigntiq/conduit` (root entry only, never `/node`) and `@aigntiq/conduit-connectors`, and imports no `node:` module.

Design: `docs/architecture.md` §9, "connectors that sign in" (#536).

## API

| Export | What it does |
|---|---|
| `createConnectorEngine({ secret, accounts, transient, locks, clients, redirectUri, http? })` | `createConduit` with the stores and the OAuth client injected. Specs default to every connector of `@aigntiq/conduit-connectors`. |
| `conduitTools(engine, { id, connector, account, owner })` | One connected account as `{ tools, toolNames, close }`, the platform's `OpenedConnector` shape. |
| `clientFromSecrets(openSecret)` | conduit's `ClientResolver` from the connector plugin's `client-id` / `client-secret` secrets. |
| `CONNECTOR_ENGINE_SECRET` | `connector-engine-secret`: the Registry secret holding the workspace's engine `secret`. The app generates it on the first Connect (#533). |
| `gmailConnectorPlugin` | The Gmail `PluginManifest` (`kind: 'connector'`). |
| `conduitConnectorManifest(spec, { hosts })` | The same manifest for any conduit connector. |

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

- Secrets: `client-id` and `client-secret` (required), the owner's own Google OAuth client, and `connector-engine-secret` (not required), the workspace's engine secret. The platform generates it on the first Connect, so it never holds readiness back and the plugin page offers no field for it (#533).
- Permissions: `secret:client-id`, `secret:client-secret`, `secret:connector-engine-secret`, `network:gmail.googleapis.com`, `network:oauth2.googleapis.com` and `tools:gmail`.
- Capabilities: `operation:<id>` for every callable operation, and `unsupported:trigger:new-email` until triggers land (#535).
