# @agentic/client

The DOM-free client layer (#1116): app-lifetime `@sigx/store` stores and the injectables they read, shared by the web shell (`apps/web`) and the planned Lynx shell.

| Export | What |
|---|---|
| `useActorDefs` / `ActorDefs` | the actor definitions the pages and stores read through; each entry provides its wire (`clientDefs()` in the browser, `platformDefs()` in SSR) |
| `useViewer` / `ViewerState` / `ViewerHook` | the signed-in viewer; the entry provides the hook (`viewerHook` on the web) |
| `useKeyValueStorage` / `KeyValueStorage` / `memoryKeyValueStorage` | sync `get` / `set` / `remove`; the web provides it over `localStorage`, tests over memory |
| `defineAppStore(name, setup)` | `defineStore(name, setup, 'singleton')`, registered for `initAppStores()`; warns in dev when a page creates it first |
| `initAppStores()` | creates every registered store; call it at the top of the shell's setup |
| `useLiveActorState(ctx, Def, () => [key, method])` | a live actor read for a store: the ordinary read plus a live subscription closed in `ctx.onDeactivated` |

Rules: no DOM, `window`, `localStorage`, `sigx` umbrella or `@sigx/runtime-dom` in `src/` (oxlint + `__tests__/dom-free.test.ts`). Design: `docs/architecture.md` §10, "Client stores".
