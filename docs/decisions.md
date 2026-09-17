# Decisions

Dated product and engineering decisions that the requirements leave open (requirements §18). Newest last.

## 2026-09-17 — bootstrap

- **Estate packages**: `@sigx/ai*` 0.1.0 is published before feature work starts (signalxjs/ai#15); the repo pins every sigx package from npm through the `catalog:`. Local checkouts are never linked.
- **First integrations (open decision 1)**: Claude Code via `@sigx/ai-agent-claude-code` + Anthropic API via `modelAgent` over `@sigx/ai-anthropic`. Copilot CLI second.
- **Daemon platform (2)**: Windows first; macOS/Linux follow from the same Node code once EXE-07 isolation is validated there.
- **Environment isolation (3)**: Claude Code accounts are isolated by `CLAUDE_CONFIG_DIR` per environment plus `settingSources: []`.
- **Collaboration policy (4)**: agents may delegate to every agent in the workspace by default; depth 3, concurrency 3, budgets split from the parent.
- **Learning policy (6)**: memory writes are automatic; instruction/skill changes require review and become new config versions.
- **Credentials and billing (7)**: users bring their own API keys, encrypted at rest with a per-deployment key. Runtime OAuth credentials stay on the machine.
- **Mobile (8)**: responsive web only in v1; a Lynx native shell is a later phase.
- **Plugin model (9)**: in-repo modules registered at build time; enable/disable per workspace; no marketplace.
- **Interoperability (11)**: A2A 1.0 JSON-RPC binding (SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask); MCP Streamable HTTP client for tools; platform MCP server as the orchestration surface.
- **Login**: GitHub OAuth behind an `AuthProvider` interface so more providers can be added.
- **Skin**: `@sigx/zero-daisyui`.
- **Repo scope**: all work stays in `andtii/agentic` as private `@agentic/*` packages; generic pieces are tracked in `promotion.md`. Friction with `@sigx/zero` is filed on andtii/zero-wip.
- **Process**: issue → worktree → PR → green CI → squash merge. No Copilot review step; `main` requires a PR and green checks, zero approvals.
- **Orchestration from outside**: every capability is an actor method; the platform MCP server projects them so an external MCP client can drive every daemon on every machine (phase 3), and the principal model carries an `external` kind with scopes from the first contracts issue.
