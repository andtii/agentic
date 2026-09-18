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
- **Skin**: `@sigx/zero-daisyui`, derived into the `agentic` design system (`@agentic/ui/design-system`) with the `control-room` theme from `docs/design/HANDOFF.md`.
- **Theme (2026-09-17, #84)**: dark only in v1 — `control-room` is the one theme, set as both scheme defaults; no toggle in the shell. A light pair is a later issue if wanted.
- **Repo scope**: all work stays in `andtii/agentic` as private `@agentic/*` packages; generic pieces are tracked in `promotion.md`. Friction with `@sigx/zero` is filed on andtii/zero-wip.
- **Process**: issue → worktree → PR → green CI → squash merge. No Copilot review step; `main` requires a PR and green checks, zero approvals.
- **Orchestration from outside**: every capability is an actor method; the platform MCP server projects them so an external MCP client can drive every daemon on every machine (phase 3), and the principal model carries an `external` kind with scopes from the first contracts issue.

## 2026-09-18 — first release: every §18 open decision, answered or deferred (#52)

The table answers each open decision of requirements §18 with the decision taken and the issue or PR that settled it, or says why it is deferred. A row that says "deferred" is not a gap in the release — it names the default the release ships with.

| # | Open decision | Decision | Settled by |
|---|---|---|---|
| 1 | First integrations | Claude Code (installed runtime, `claude-code`) through `@sigx/ai-agent-claude-code` on a paired machine, and the Anthropic API (`anthropic-api`) as the platform-managed agent over `modelAgent` + `@sigx/ai-anthropic`. Copilot CLI and other CLIs follow through the same `RuntimeDriver` seam; no other model provider in v1. | #20 (PR #77), #21 (PR #61), #76 (driver seam) |
| 2 | Operating systems | Windows first: the daemon installs as a per-user Scheduled Task from a self-contained zip (`pnpm --filter @agentic/daemon package`). The same Node code runs on macOS and Linux in the foreground; their service units, installers and EXE-07 validation are a follow-up (macOS Keychain behaviour unverified). | #19 (PR #78), #43 (PR #109), #52 |
| 3 | Environment isolation | One Claude Code account = one `profileDir` = `CLAUDE_CONFIG_DIR`, `settingSources: []`, the daemon's own `CLAUDE_CONFIG_DIR` and every `ANTHROPIC_*` removed from the child env; sessions confined to `cwdRoots`; a shared config dir is a `doctor` error the platform shows per environment. No other isolation mechanism in v1 (no VMs, no containers). | #20 (PR #77), #43 (PR #109), `docs/multi-account.md` |
| 4 | Collaboration policy | An agent may delegate to every agent of the workspace by default (`collaborators` narrows it); depth 3, concurrency 3, budgets split from the parent; the stricter approval policy wins across a delegation. | #17 (PR #67), #39 (PR #112), #40 (PR #130) |
| 5 | Shared resources | Memory: private scope per agent by default; shared knowledge only through named `shared:<name>` scopes an agent's `memoryPolicy.shared` declares, with an ACL on the scope; chat membership alone grants nothing (AC-10). Shared folders and projects are the daemon's `cwdRoots` per environment — no platform-level shared folder or project object in v1. | #26 (PR #66), #16 (PR #62), #19 (PR #78) |
| 6 | Learning policy | Memory writes are automatic (turn end); a correction becomes a lesson with evidence and conditions; instruction or skill changes are proposals that need review and become new config versions — never applied silently. | #27 (PR #72), #41 (PR #97) |
| 7 | API credentials and billing | Users bring their own keys; stored sealed under the deployment's `WORKSPACE_KEK` (Registry secrets); usage and cost are shown per turn / task / agent with estimates flagged, budgets stop delegation. No platform billing. **Shipping default:** the deployment's `ANTHROPIC_API_KEY` serves every workspace until the per-workspace key is wired to the session factory (`docs/runbook.md` §10). | #45 (PR #95), #48 (PR #96), #35 (PR #127) |
| 8 | Mobile delivery | Responsive web only (400 px pass); notifications land in the Inbox actor; Web Push is a channel plugin with VAPID keys, seam in place but no keys wired in v1. No native shell. | #47 (PR #117), #29 (PR #60), #42 (PR #93) |
| 9 | Plugin model | In-repo modules registered at build time with a manifest (permissions, dependents); enabled / disabled / removed per workspace through the Registry, dependents identified on disable (AC-13); no marketplace, no out-of-process isolation. | #48 (PR #96), #13 (PR #54) |
| 10 | Group activation | Activated = mentions ∩ members; none → the coordinator if set; none and exactly one agent member → that agent; otherwise the post is stored only. `mentions: 'all'` addresses every agent member. No unsolicited contributions in v1 — an agent speaks only when activated or when a delegation result returns to the chat. | #16 (PR #62), #34 (PR #123), #39 (PR #112) |
| 11 | First-release interoperability | A2A 1.0 JSON-RPC binding: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, agent card at `/.well-known/agent-card.json`; MCP Streamable HTTP client for tools (resources and prompts enumerated as unsupported); the platform's own MCP server (`/_agentic/mcp`) behind OAuth 2.1 + DCR with scoped tool families. | #30 (PR #65), #31 (PR #71), #50 (PR #119) |
| 12 | Operations | Retention: session logs and task payloads 90 days (recorded, sweeper deferred), artifacts 30 days (R2 lifecycle rule), everything else until deleted; `exportAll` / `deleteAll` are the backup and the cascade. Hosting: one Worker + one SQLite Durable Object class on Cloudflare, one R2 bucket, no D1. **Deferred:** availability, latency and recovery targets are not quantified — a single-user private deployment has no SLO yet; revisit when a second deployment exists. | #48 (PR #96, `docs/retention.md`), #33 (PR #79), #52 (`docs/runbook.md`) |
| 13 | First-release scope | Launch = PRD §16 items 1–9 as demo 1 (API agent in the web UI on Cloudflare) and demo 2 (Claude Code on a paired Windows machine with approvals and cancel), plus the acceptance suite AC-01 … AC-15. Immediate follow-ups, not launch: the ops pages on live data, `smoke:demo2`, per-workspace API keys, Web Push, the session-log sweeper, macOS/Linux installers (`docs/release-checklist.md`). | #11, #35, #38, #51 (PR #138), #52 |
