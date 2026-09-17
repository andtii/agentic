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

## Platform tools

`defineTool`s over abstract ports (`packages/runtimes/src/tools/ports.ts`), so they run and test without actors. Names are provider tool names (`[A-Za-z0-9_-]`):

| Tool | Port | Annotations |
|---|---|---|
| `memory_search` | `MemoryPort.search` | `readOnly`, `idempotent` |
| `memory_remember` | `MemoryPort.remember` (provenance `source: 'agent'`) | |
| `delegate` | `TaskPort.delegate` (child id from `callId`, §7) | `openWorld` |
| `chat_post` | `ChatPort.post` | |
| `task_report` | `TaskPort.report` | `idempotent` |
| `ask_user` | `ChatPort.ask` (the platform parks the Task `waiting {input}`) | |

`platformTools(ports)` gives all six; `grantedPlatformTools(ports, grants)` the ones a config grants.

## Tests

`pnpm test packages/runtimes`. The conformance suite runs over `mockModel`; `__tests__/anthropic/fixtures/tool-roundtrip.json` is a recorded `memory_search` round trip replayed through `replayAgent` (re-record with `RECORD_FIXTURES=1 pnpm test fixture`).
