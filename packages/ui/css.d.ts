// `@agentic/ui/css`'s types condition: a stylesheet, imported for its side effect, has no bindings.
// Checked in rather than pointing at the build's `dist/ds/css/index.d.ts` (the same one line), so
// `pnpm typecheck` resolves the import on a clean checkout, before `pnpm build` (CI's order).
export {};
