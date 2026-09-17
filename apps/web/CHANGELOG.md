# Changelog

All notable changes to `@agentic/web` (Keep a Changelog, semver).

## [Unreleased]

- Scaffolded with `sigx create` (SSR + hydrate, Cloudflare target, router, server functions); package renamed to `@agentic/web`, sigx deps on the `catalog:`.
- Design system: `@sigx/zero/css` + `@sigx/zero-daisyui/css`, `installThemes()` in both entries, `themeInitScript` in `<head>` via `useHead`, per-request `ThemeProvider`.
- Responsive shell from `@agentic/ui` (`AppShell`) with the primary navigation in `src/nav.ts`.
- Route skeleton with mock data: `/`, `/chats/:id`, `/agents`, `/agents/:id`, `/tasks/:id`, `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`.
- `zero:validate` runs as the first step of `build` (so CI's `pnpm build` runs it); Playwright smoke at 400px and 1280px (`test:e2e`, local only).
