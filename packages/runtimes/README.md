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

- **Isolation (EXE-04/05/07)**: one `claudeCode()` agent per environment, `settingSources: []`, `CLAUDE_CONFIG_DIR = profileDir`. The daemon's own `CLAUDE_CONFIG_DIR` and every `ANTHROPIC_*` variable are removed from the child environment, so no environment picks up another account; an environment without `profileDir` uses the default config dir and `doctor` warns. `doctor` compares config dirs normalised (separators, `..`, trailing slash; case-folded on Windows) and reports auth per profile; its codes are `CLAUDE_CODE_DOCTOR_CODES` (`shared-config-dir` is the error, `default-config-dir` / `auth-*` the warnings and infos). `__tests__/claude-code/isolation.test.ts` is the isolation conformance run: three profiles, each session's child environment differs from the others only in `CLAUDE_CONFIG_DIR`, and starting one never changes another's. `docs/multi-account.md` has the manual checklist for the real CLI (Windows verified; macOS Keychain not).
- **Sessions**: `cwd` must be inside the environment's `cwdRoots`; `system` is appended to Claude Code's preset (`systemPromptPreset: true`); `model`, `maxTurns`, `maxBudgetUsd`, the policy and `resume` pass through.
- **Memory (MEM-10)**: the platform's `## Memory` block becomes `## Platform memory` with a note that it is not Claude Code memory; the report lists `memory.platform` as supported and `memory.runtime` (CLAUDE.md, settings) as unsupported with the reason.
- **Platform tools**: the names in `OpenSpec.tools` are served as client tools with the platform's own name, description and schema; `execute` calls `callTool`, which the daemon sends as `tool.call`. A name the daemon has no definition for is not served and is listed as unsupported.
- **Auth** (`readProfileAuth`): `.credentials.json` in the config dir — a refresh token is `ok`, an expired access token without one `expired`, none `missing`; identity from `.claude.json`. macOS keeps credentials in the Keychain, so it reports `unknown` there.

## Platform tools

`defineTool`s over abstract ports (`packages/runtimes/src/tools/ports.ts`), so they run and test without actors. Names are provider tool names (`[A-Za-z0-9_-]`):

| Tool | Port | Annotations |
|---|---|---|
| `memory_search` | `MemoryPort.search` | `readOnly`, `idempotent` |
| `memory_remember` | `MemoryPort.remember` (provenance `source: 'agent'`) | |
| `delegate` | `TaskPort.delegate` (child id from `callId`, §7); optional `environmentId` / `workdir` for the child (#190; a `workdir` needs its `environmentId`); result flattened to `{ taskId, status, text?, output?, artifacts, verified, error?, notStopped? }`; emits `agent-start` / `agent-update` for the child when the host's tool context can emit | `openWorld` |
| `chat_post` | `ChatPort.post`; optional `attachments` (`agentic-file:` URIs, #203) passed as `ChatPost.attachments` | |
| `chat_file_read` | `ChatFilesPort.read` (`PlatformPorts.files`, #203): `{ uri }` an `agentic-file:` URI; a text file returns `{ name, mediaType, bytes, text }` (`truncated` + a note past 256 KB), any other file a `note` naming it as binary (an image: attached to the turn when it fits); no `files` port fails the call | `readOnly`, `idempotent` |
| `task_report` | `TaskPort.report` | `idempotent` |
| `ask_user` | `ChatPort.ask` (the platform parks the Task `waiting {input}`) | |

`platformTools(ports)` gives all seven; `grantedPlatformTools(ports, grants)` the ones a config grants.

## Policy (`src/policy`, #121)

The approval policy compile — `compilePolicy(rules)`, `grantPolicy(grants)`, `agentPolicy(config)`, `constrainPolicy(policy, constraints)`, `sessionPolicy(spec)` and `sessionPolicyOf(OpenSpec.policy)` — lives here, below `@agentic/platform`, so the machine daemon compiles the SAME session policy from the rules an `OpenSpec` carries that a local session runs under; the platform re-exports it. Rules are first match over `tools` / `categories` / `source`; a grant decides per tool (`ask` / `deny` / allow); constraints (a delegated task's ancestors) only ever tighten (deny > ask > allow).

## Tests

`pnpm test packages/runtimes`. The anthropic conformance suite runs over `mockModel`; the claude-code one runs `agentConformance` on the driver's agent over the adapter's scripted fake `query` (`__tests__/claude-code/fake-query.ts`, adapted from signalxjs/ai); `__tests__/anthropic/fixtures/tool-roundtrip.json` is a recorded `memory_search` round trip replayed through `replayAgent` (re-record with `RECORD_FIXTURES=1 pnpm test fixture`).
