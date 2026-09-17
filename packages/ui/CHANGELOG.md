# Changelog

All notable changes to `@agentic/ui` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- Layout tier on `data-l-*` (`src/layout`): `Stack`/`Row`/`Col` (one `stack` scope, `data-orientation`), `Spacer`, `layoutAttrs`, breakpoint-prefixed overrides (`at={{ md: … }}`), `layout.css` step table over `--space-*`; `useMediaQuery` (SSR-safe). Exported as `@agentic/ui/layout.css`.
- App shell (`src/shell`): `AppShell` (zero `Navbar` + modal `Drawer` below 768px, static sidebar above; router-agnostic `link` slot; `currentPath` → `data-state="active"`), `ThemeToggle`; `shell.css` exported as `@agentic/ui/shell.css`.
- Forms (`src/forms`, #25) on zero's `model=` form contract, each posting pre-hydration and read back by one parser: `AgentForm` (identity, skills/tools/connectors multi-select with a per-tool mode, per-category approval policy, memory, execution defaults and limits, collaborators, version reason; `submit` / `invalid` events, exposed `reset()` / `submit()`), `ConfigVersions` (history with revert, a real form per row), `EnvironmentCard` + `environmentStatus`, `SettingsForm` (IANA time zone, notification kinds, push, default environment). Models: `toAgentDraft` / `fromAgentDraft` / `agentDraftFromFormData` / `parseAgentFormData` / `validateAgentDraft` and the settings equivalents; labelled field wrappers (`TextField`, `TextareaField`, `SelectField`, `NumberField`, `SwitchField`, `MultiSelectField`).
- Zero gap: `MultiSelect` (`src/_zero-gaps`, scope `ai-multi-select`) — a `string[]` model over zero's `Combobox`, chips posting repeated hidden inputs (andtii/zero-wip#479).
