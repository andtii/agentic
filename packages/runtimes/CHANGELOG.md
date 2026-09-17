# Changelog

All notable changes to `@agentic/runtimes` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- `anthropic-api` runtime: `createPlatformModelAgent(config, deps)` — `modelAgent` over `@sigx/ai-anthropic` with the granted platform tools, a system prompt assembled from the frozen config (`buildSystemPrompt`; a version-pinned `SkillRef` matches only a skill resolved at that version), priced usage (`ANTHROPIC_PRICING`, `priceUsage`, `usageRow` with the `estimated` flag) and a `CapabilityReport`.
- `claude-code` runtime (#20), subpath `@agentic/runtimes/claude-code` (Node only): `claudeCodeDriver()` implements the core `RuntimeDriver<AgentSession, Policy>` — one `claudeCode()` agent per environment with `settingSources: []` and its own `CLAUDE_CONFIG_DIR` (the daemon's `CLAUDE_CONFIG_DIR` and `ANTHROPIC_*` never reach a child), sessions with `cwd` checked against `cwdRoots`, the platform system prompt appended to Claude Code's preset with the memory block relabelled platform-owned (`claudeCodeSystemPrompt`), `maxTurns` / `maxBudgetUsd` / `model` / policy / resume, and the spec's platform tools as client tools bridged through `callTool` (`bridgedPlatformTools`); `claudeCodeCapabilityReport`; `inspect` reads auth status and identity from the profile (`readProfileAuth`); `doctor` fails on two environments sharing a config dir (`claudeCodeDoctor`, `configDirKey`).
- Platform tools over abstract ports (`MemoryPort`, `TaskPort`, `ChatPort`): `memory_search`, `memory_remember`, `delegate`, `chat_post`, `task_report`, `ask_user`.
