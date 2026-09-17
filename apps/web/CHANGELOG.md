# Changelog

All notable changes to `@agentic/web` (Keep a Changelog, semver).

## [Unreleased]

- Cloudflare worker entry (#33): one bundle exports the Worker and the `ActorHost` Durable Object over every platform actor (`src/actors.app.ts`: Workspace, Agent, Chat, ChatPage, Task, Session, Schedule, Memory, Inbox); actor HTTP mount and object-terminated sockets via `createWorkerHandler({ socket: { terminate: 'object' } })`; `createServerApp` with `serverAuth` stamped in both halves so principals cross the hop; auth routes mounted when the secrets are set; the daemon socket path answers 501 until the Machine actor (#36). `wrangler.jsonc`: `ACTORS` binding, `migrations: [{ tag: 'v1', new_sqlite_classes: ['ActorHost'] }]`, `define.__DEV__`, `ARTIFACTS` R2 bucket, a `preview` environment. Scripts `test:workers` (`@cloudflare/vitest-pool-workers`) and `deploy:preview`. Ports still to wire are explicit: Session factory (#35), daemon command sink (#36), Schedule trigger (#42).
- Scaffolded with `sigx create` (SSR + hydrate, Cloudflare target, router, server functions); package renamed to `@agentic/web`, sigx deps on the `catalog:`.
- Design system: `@sigx/zero/css` + `@sigx/zero-daisyui/css`, `installThemes()` in both entries, `themeInitScript` in `<head>` via `useHead`, per-request `ThemeProvider`.
- Responsive shell from `@agentic/ui` (`AppShell`) with the primary navigation in `src/nav.ts`.
- Route skeleton with mock data: `/`, `/chats/:id`, `/agents`, `/agents/:id`, `/tasks/:id`, `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`.
- `zero:validate` runs as the first step of `build` (so CI's `pnpm build` runs it); Playwright smoke at 400px and 1280px (`test:e2e`, local only).
