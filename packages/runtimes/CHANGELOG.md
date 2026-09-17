# Changelog

All notable changes to `@agentic/runtimes` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- `anthropic-api` runtime: `createPlatformModelAgent(config, deps)` — `modelAgent` over `@sigx/ai-anthropic` with the granted platform tools, a system prompt assembled from the frozen config (`buildSystemPrompt`; a version-pinned `SkillRef` matches only a skill resolved at that version), priced usage (`ANTHROPIC_PRICING`, `priceUsage`, `usageRow` with the `estimated` flag) and a `CapabilityReport`.
- Platform tools over abstract ports (`MemoryPort`, `TaskPort`, `ChatPort`): `memory_search`, `memory_remember`, `delegate`, `chat_post`, `task_report`, `ask_user`.
