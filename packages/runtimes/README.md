# @agentic/runtimes

Runtime adapters: platform-managed Anthropic agent (modelAgent), Claude Code driver, and the platform tools (memory, delegate, chat, task).

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.

## `anthropic-api`: `createPlatformModelAgent`

A `FrozenAgentConfig` becomes a running API agent (architecture §5a):

```ts
import { createPlatformModelAgent } from '@agentic/runtimes';

const platform = createPlatformModelAgent(config, {
    ports,                                 // MemoryPort, TaskPort, ChatPort — the Session actor's
    anthropic: { apiKey },                 // BYO key; or `model` for a ready LanguageModel (tests: mockModel)
    store,                                 // TranscriptStore; without one the SessionRef carries the transcript
    skills,                                // ResolvedSkill[] for the config's SkillRefs
    memories                               // MemoryEntry[] retrieved for this session → the memory block
});

const session = await platform.agent.session({ policy, interactive: true });
for await (const ev of session.prompt(input)) {
    if (ev.type === 'usage') ledger.append(platform.usageRow(ev, { sessionId: session.id, taskId, at: Date.now() }));
}
```

What you get back: `agent` (`modelAgent` over `anthropic().model(config.execution.model)`), the assembled `system` prompt, the `tools` roster, `pricing` (`estimated: true` for a model the table does not list), a `CapabilityReport` (AGT-09), and `usageRow` to turn a `usage` or `turn-end` event into a Ledger row (OPS-07).

- **Tools** come from the config's `ToolGrant`s: a platform tool is on the roster only when granted (`allow` or `ask`); `deny` and skills never add one (AGT-04). The policy compiled from the same grants decides per call.
- **System prompt** (`buildSystemPrompt`): identity, responsibilities (`role`), instructions, skills (with a note that skills grant no authority), the tool roster, then the memory block — stable sections first so the provider's prompt cache keeps the prefix.
- **Pricing** (`ANTHROPIC_PRICING`, `priceUsage`): USD per million tokens for input, output, cache read and cache write; a dated snapshot resolves to its id; an unknown id is priced by family with `estimated: true`.
- **Limits**: `execution.limits.maxSteps` is the engine's rounds per turn; the other limits are the driver's (§5a).

## `claude-code`: `claudeCodeDriver`

The machine daemon's driver for Claude Code (architecture §5b), on its own Node-only subpath so the edge entry never pulls in process spawning:

```ts
import { claudeCodeDriver } from '@agentic/runtimes/claude-code';

const driver = claudeCodeDriver();                        // tests: { query: fakeQuery, listen, spawn, parentEnv, auth }
const inspection = await driver.inspect(env);             // authStatus, identity, isolation, CapabilityReport → hello/env
const { session, capabilities } = await driver.open(env, openSpec, { sessionId, callTool, policy });
const report = await driver.doctor(environments);         // ok: false when two environments share a config dir
```

- **Isolation (EXE-04/05/07)**: one `claudeCode()` agent per environment, `settingSources: ['project']` (`SETTING_SOURCES`: the repository's `CLAUDE.md`, `.claude/settings.json`, hooks and skills load from `cwd` upward; `user` and `local` never, #461), `CLAUDE_CONFIG_DIR = profileDir`. The daemon's own `CLAUDE_CONFIG_DIR` and every `ANTHROPIC_*` variable are removed from the child environment, so no environment picks up another account; an environment without `profileDir` uses the default config dir and `doctor` warns. `doctor` compares config dirs normalised (separators, `..`, trailing slash; case-folded on Windows) and reports auth per profile; its codes are `CLAUDE_CODE_DOCTOR_CODES` (`shared-config-dir` is the error, `default-config-dir` / `auth-*` / `profile-unreadable` the warnings and infos). The report is the verdict the platform receives, so no finding names a path — environments are named by name and id (#274). `__tests__/claude-code/isolation.test.ts` is the isolation conformance run: three profiles, each session's child environment differs from the others only in `CLAUDE_CONFIG_DIR`, and starting one never changes another's. `docs/multi-account.md` has the manual checklist for the real CLI (Windows verified; macOS Keychain not).
- **Sessions**: `cwd` must be inside the environment's `cwdRoots`; `system` is appended to Claude Code's preset (`systemPromptPreset: true`); `model`, `maxTurns`, `maxBudgetUsd`, the policy and `resume` pass through.
- **Memory (MEM-10)**: the platform's `## Memory` block becomes `## Platform memory` with a note that it is not Claude Code memory; the report lists `memory.platform` as supported and `memory.runtime` (CLAUDE.md, settings — loaded, but the project's) as unsupported with the reason.
- **Platform tools**: the names in `OpenSpec.tools` are served as client tools with the platform's own name, description and schema; `execute` calls `callTool`, which the daemon sends as `tool.call`. A name the daemon has no definition for is not served and is listed as unsupported.
- **MCP connectors (#280)**: `claudeCodeDriver({ connectors })` opens each `OpenSpec.connectors` entry with the injected `DaemonConnectorOpener` (the daemon passes `@agentic/mcp`'s openers). Credential values come from `callTool('connector_credentials', { connectorId })` and are held for that session only. A stdio server runs in the connector's `cwd` or the session's, which must be inside `cwdRoots`. The tools are served beside the platform tools as `<id>__<tool>` and closed with the session. The policy sees them as `source: 'mcp'` with a category from the hints (`withConnectorPolicy`). A connector that cannot be opened is left out: `withUnavailableConnectors` names it in the prompt's "Connectors not available", and the report lists it as `connector:<id>`, with credential values scrubbed. The session opens either way.
- **Auth** (`readProfileAuth`): `.credentials.json` in the config dir — a refresh token is `ok`, an expired access token without one `expired`, none `missing`; identity from `.claude.json`. macOS keeps credentials in the Keychain, so it reports `unknown` there.

### Usage limits: `claudeCodeQuota` (#269)

`claudeCodeQuota()` is the `quota` source the daemon runs per Claude Code environment (#261). It **probes** an idle account for what `claude` → `/usage` shows. It uses the SDK's experimental usage call on a query that is never prompted, so there is no model call and no cost. Measured 2026-09-19 on three Max profiles and one signed-out profile: 0.25–0.9 s, `total_cost_usd` 0, no messages, no leftover process. It also maps each streamed `rate_limit_event` to a one-window update (`fromSignal`).

Scales differ:
- the probe reports utilization as 0..100
- the stream reports it as a 0..1 fraction, taken from the `anthropic-ratelimit-unified-*` response headers

Both are normalized to 0..1. Only normalized snapshots leave the machine. Recorded fixtures: `__tests__/claude-code/fixtures/usage-*.json`.

## Platform tools

`defineTool`s over abstract ports (`packages/runtimes/src/tools/ports.ts`), so they run and test without actors. Names are provider tool names (`[A-Za-z0-9_-]`):

| Tool | Port | Annotations |
|---|---|---|
| `memory_search` | `MemoryPort.search` | `readOnly`, `idempotent` |
| `memory_remember` | `MemoryPort.remember` (provenance `source: 'agent'`) | |
| `delegate` | `TaskPort.delegate` (child id from `callId`, §7); optional `environmentId` / `workdir` for the child (#190; a `workdir` needs its `environmentId`); result flattened to `{ taskId, status, text?, output?, artifacts, verified, error?, notStopped?, note? }`; a child still running when the port's wait window passes comes back `running` with its `taskId` and a `note` (#599) — a verbatim retry would start a second child, so `follow: <taskId>` waits for the same one; a refused `workdir` without `environmentId` names the assignee's environments (`TaskPort.environments`, `describeEnvironments`); emits `agent-start` / `agent-update` for the child when the host's tool context can emit (no terminal update while it runs) | `openWorld` |
| `chat_post` | `ChatPort.post`; optional `attachments` (`agentic-file:` URIs, #203) passed as `ChatPost.attachments` | |
| `chat_file_read` | `ChatFilesPort.read` (`PlatformPorts.files`, #203): `{ uri }` an `agentic-file:` URI; a text file returns `{ name, mediaType, bytes, text }` (`truncated` + a note past 256 KB), any other file a `note` naming it as binary (an image: attached to the turn when it fits); no `files` port fails the call | `readOnly`, `idempotent` |
| `task_report` | `TaskPort.report` | `idempotent` |
| `ask_user` | `ChatPort.ask` → `AskOutcome`: `{ answer }` within a short window, else `{ status: 'pending', questionId, note }` — the agent ends its turn and the answer starts it again in the chat (#285) | |
| `usage_limits` | `UsagePort.limits` (`PlatformPorts.usage`, #272): `{ machineId?, runtime? }` → core `UsageLimits`, every account's latest quota snapshot and its age; no `usage` port fails the call | `readOnly`, `idempotent` |
| `projects` | `ProjectPort` (`PlatformPorts.projects`, #334): `{ action: 'list' }` → `{ projects: ProjectSummary[] }` (id, name, description, the environments with a folder); `{ action: 'set', chatId, projectId \| null, force? }` → `ProjectPort.set` (`Chat.setProject` as the agent, audited `chat.project-set`), answering `{ chatId, projectId, previous }`. The guard: a chat already in another project is refused unless `force`, which the description reserves for an explicit request from the user; the description also tells the coordinator to `list` only when the chat has no project and the message names one, to set only a registered project (never a folder on disk) and to `ask_user` with the candidates when none or several match. No `projects` port fails the call | `idempotent` |

`platformTools(ports)` gives all nine; `grantedPlatformTools(ports, grants)` the ones a config grants.

## Files a tool call wrote (`src/touches.ts`, #565)

`filesTouched(runtime, call)` → `FileTouch[]` (`{ path, line? }`, the path as the call gave it) for a `{ name, input }` — a transcript's tool part or a `tool-call` event. Each runtime's extractor knows its own tool names; `claude-code` is built in (`claudeCodeFileTouches`: `file_path` of Edit, MultiEdit and Write, `notebook_path` of NotebookEdit). `registerFileTouches(runtime, extractor)` adds or replaces one and returns the undo. A runtime without an extractor touches nothing. Pure and edge-safe: the web app's "View diff" links and "Edited by" lines read it.

## Plugin manifests (`src/plugins.ts`, #228)

Each runtime ships a `PluginManifest` (PLG-02) for the composition root's catalogue; nothing here registers one. A runtime plugin's id IS its `RuntimeId` — the Registry finds an agent's dependency by `execution.runtime === manifest.id`.

| Manifest | id | Config | Secrets | Permissions |
|---|---|---|---|---|
| `anthropicApiPlugin` | `anthropic-api` | `defaultModel`: one of `ANTHROPIC_MODEL_IDS` (the priced ids plus the provider default), default `DEFAULT_ANTHROPIC_MODEL` | `anthropic-api-key` (`ANTHROPIC_API_KEY_SECRET`, required) | `secret:anthropic-api-key` |
| `claudeCodePlugin` | `claude-code` | none | none — the login stays on the machine (EXE-10) | `machine:*` |

`claudeCodePlugin` is a **harness runtime** that reports usage limits (capabilities `daemon-hosted`, `harness`, `usage-limits`); `anthropicApiPlugin` is a **model runtime** (`platform-hosted`, `model`; #313). `claudeCodePlugin` lists core's `DAEMON_HOSTED_CAPABILITY`, so `pluginReadiness` answers `needs-machine` until a machine offers a `claude-code` environment. `RUNTIME_PLUGINS` is both. The key is a secret, never a config value: the schema refuses unknown keys.

## Policy (`src/policy`, #121)

The approval policy compile — `compilePolicy(rules)`, `grantPolicy(grants)`, `agentPolicy(config)`, `constrainPolicy(policy, constraints)`, `sessionPolicy(spec)` and `sessionPolicyOf(OpenSpec.policy)` — lives here, below `@agentic/platform`, so the machine daemon compiles the SAME session policy from the rules an `OpenSpec` carries that a local session runs under; the platform re-exports it. Rules are first match over `tools` / `categories` / `source`; a grant decides per tool (`ask` / `deny` / allow); constraints (a delegated task's ancestors) only ever tighten (deny > ask > allow).

## Tests

`pnpm test packages/runtimes`. The anthropic conformance suite runs over `mockModel`; the claude-code one runs `agentConformance` on the driver's agent over the adapter's scripted fake `query` (`__tests__/claude-code/fake-query.ts`, adapted from signalxjs/ai); `__tests__/anthropic/fixtures/tool-roundtrip.json` is a recorded `memory_search` round trip replayed through `replayAgent` (re-record with `RECORD_FIXTURES=1 pnpm test fixture`).
