# Promotion candidates

Work that starts in this repo but is generic. Each row gets a `promote` label on its issue and a line here, so lifting it into the sigx estate later needs no archaeology. Nothing here goes upstream until it has stabilised in this app.

| Piece (here) | Lands in | When |
|---|---|---|
| DO-backed `EventLogStore` / `TranscriptStore` (`packages/platform/src/session`) | signalxjs/ai `@sigx/ai-actors` (signalxjs/ai#19) | after v1 stabilises |
| MCP client (`packages/mcp/src/client`: Streamable HTTP over fetch, tool mapping, capability report; stdio in `packages/mcp/src/node`) | `@sigx/ai-agent/harness` (+ `@sigx/ai-agent-node` for stdio) | after resources/prompts are added |
| A2A server + client adapter (`packages/a2a`) | `@sigx/ai-agent-a2a` | after the conformance subset passes |
| Memory / Learning interfaces (`packages/core`) | `@sigx/ai-agent` (`./memory`) | once two implementations exist |
| BM25-ish memory ranking + versioned NDJSON export (`packages/memory/src/rank`, `src/export`) | `@sigx/ai-agent` (`./memory`), beside the interfaces | once a second MemoryPlugin exists |
| Permission-free proposal guard + lesson helpers (`packages/learning/src/proposals`, `src/lessons`) | `@sigx/ai-agent` (`./memory`), beside the Learning interfaces | once a second LearningPlugin exists |
| DelegateTool (`packages/runtimes/src/tools/delegate.ts`) | `@sigx/ai-agent` | after limit semantics settle |
| Daemon-protocol envelope + relay (`packages/daemon-protocol`, `apps/daemon`) | `@sigx/ai-agent/wire` + `@sigx/ai-agent-node` | later |
| `ai-thread` / `ai-message` / `ai-composer` / `ai-tool-call` / `ai-reasoning` fragment (`packages/ui`) | signalxjs/ai `@sigx/ai-ui` (signalxjs/ai#17) | soon — generic from day one |
| `MultiSelect` (`packages/ui/src/_zero-gaps/multi-select.tsx`) | `@sigx/zero` Combobox multiple mode (andtii/zero-wip#479) | when zero ships it — delete the gap, re-point `MultiSelectField` |
| Stack / Row / Col / Spacer on `data-l-*` + `useMediaQuery` (`packages/ui/src/layout`) | `@sigx/zero` layout tier (andtii/zero-wip#473, landed on main) | when a zero release ships it — delete the folder, re-point the imports |
| Schedule / timezone reminder actor (`packages/platform/src/schedule`) | `@sigx/actors-workflow` schedule actor (signalxjs/actors#390) | later |
| Claude Code profile isolation + doctor (`packages/runtimes/src/claude-code`: per-profile child env, shared-config-dir check, credentials-file auth status) | `@sigx/ai-agent-claude-code` | once validated on macOS |
| Pricing table for Anthropic models (`packages/runtimes/src/anthropic/pricing.ts`) | `@sigx/ai-anthropic` | when a second consumer appears |
