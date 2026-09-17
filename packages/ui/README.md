# @agentic/ui

Zero-based UI: the ai-* chat fragment (thread, message, composer, tool call, reasoning, approval), layout shell and streaming markdown.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.

## Layout tier (`src/layout`)

Stand-in for zero's layout tier until a release ships it (andtii/zero-wip#473 landed on main). `Stack`, `Row`, `Col` render one `data-scope="stack"` carrier with `data-orientation`; `Spacer` takes the free space. Layout facts are `data-l-*` attributes whose values are the design system's `--space-*` ramp (`gap`, `pad`) or flex keywords (`align`, `justify`, `wrap`, `grow`); per-breakpoint overrides put the breakpoint in prefix position (`at={{ md: { gap: 'lg' } }}` → `data-l-md-gap="lg"`). Import `@agentic/ui/layout.css` once. `useMediaQuery(query)` is the SSR-safe `matchMedia` signal.

```tsx
import { Row, Col, Spacer } from '@agentic/ui';

<Row gap="md" align="center" at={{ md: { gap: 'xl' } }}>
    <Col grow>…</Col>
    <Spacer />
    <button>Save</button>
</Row>
```

## App shell (`src/shell`)

`AppShell` is zero's `Navbar` + a modal `Drawer` (below 768px) or a sticky sidebar (above) around `<main>`. It is router-agnostic: pass `items` and render your router's link in the `link` slot; `currentPath` marks the active item. `ThemeToggle` flips the design system's light/dark pair through `useTheme()` (give server renders a `ThemeProvider`). Import `@agentic/ui/shell.css` once.

```tsx
<ThemeProvider>
    <AppShell brand="agentic" items={NAV} currentPath={route.path}
        slots={{ link: ({ item }) => <Link to={item.href}>{item.label}</Link> }}>
        <RouterView />
    </AppShell>
</ThemeProvider>
```

## Forms

`AgentForm`, `ConfigVersions`, `EnvironmentCard` and `SettingsForm` bind through zero's `model=` contract and also work without JS:

```tsx
<AgentForm model={() => state.config} tools={toolOptions} action="/agents/a1/config" onSubmit={({ config, reason }) => save(config, reason)} />
```

- The form edits a draft; a valid submit writes the config back through the model and emits `submit`. An invalid submit is blocked, errors render beside their fields (`Field.Error`, `role="alert"`, wired to the control by `aria-describedby`) and `invalid` fires; `reset()` restores the draft.
- Every control has a real `name` (see `AGENT_FIELDS` / `SETTINGS_FIELDS`), so the form posts before hydration. On the server, `parseAgentFormData(formData)` / `parseSettingsFormData(formData)` return the same config plus the validation errors.
- Persistence is the caller's: the forms emit, they never write to an actor.
