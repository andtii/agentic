# Changelog

All notable changes to `@agentic/ui` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- Layout tier on `data-l-*` (`src/layout`): `Stack`/`Row`/`Col` (one `stack` scope, `data-orientation`), `Spacer`, `layoutAttrs`, breakpoint-prefixed overrides (`at={{ md: … }}`), `layout.css` step table over `--space-*`; `useMediaQuery` (SSR-safe). Exported as `@agentic/ui/layout.css`.
- App shell (`src/shell`): `AppShell` (zero `Navbar` + modal `Drawer` below 768px, static sidebar above; router-agnostic `link` slot; `currentPath` → `data-state="active"`), `ThemeToggle`; `shell.css` exported as `@agentic/ui/shell.css`.
