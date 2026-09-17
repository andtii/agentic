# agentic — Unified Agent Platform

Persistent AI agents with their own identity, memory, skills and permissions; direct and group chats; delegation with tracked tasks; installed CLI runtimes (Claude Code first) driven through machine daemons; API-based agents; A2A + MCP interoperability; reminders and scheduled work; hosted on Cloudflare Workers + Durable Objects; responsive web UI.

Built on the [sigx](https://sigx.dev) estate: `@sigx/ai-agent` for the agent contract and runtime adapters, `@sigx/actors` for persistent addressable state, `@sigx/zero` for the UI.

- Requirements: [`docs/requirements.md`](docs/requirements.md)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/decisions.md`](docs/decisions.md)
- What may move upstream later: [`docs/promotion.md`](docs/promotion.md)
- How agents work here: [`AGENTS.md`](AGENTS.md)

## Layout

```
apps/web        sigx SSR app + actors host on Cloudflare Workers (UI on @sigx/zero + zero-daisyui)
apps/daemon     agentic-daemon — the machine daemon (Windows first)
packages/core   edge-safe contracts (zero deps)
packages/platform · runtimes · memory · learning · daemon-protocol · ui · mcp · a2a
```

## Develop

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm wt new <N-short-slug>     # every change happens in a worktree, never on main
```

Work is tracked as sub-issues of the tracking issue (`gh issue list --label tracking`). Each sub-issue is written so a fresh agent can execute it from its body plus `docs/architecture.md`.

MIT © Andreas Ekdahl
