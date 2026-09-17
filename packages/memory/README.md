# @agentic/memory

Default MemoryPlugin (MEM-01..09, MEM-12): a pure, storage-agnostic core and the in-memory store built on it. The Memory actor in `@agentic/platform` is the same core over `@sigx/actors` persistence.

Design: `docs/architecture.md` §8. What may move into the sigx estate later: `docs/promotion.md`.

## Layout

| Folder | What |
|---|---|
| `src/tokenize` | `tokenize`, `normalizeTag` — one tokenizer for indexing and querying |
| `src/rank` | BM25 over text + tags + subject + `conditions`, kind weights (preference 1.3 > lesson 1.2 > fact 1.1 > working 1.0 > record 0.9 > assumption 0.8), confidence weights, recency decay (30-day half-life, floor 0.5), filters, the `limit` / `maxBytes` budget (defaults 20 entries / 4 KB) |
| `src/state` | `MemoryState` + `MemoryLogEntry` + `applyMemoryLog` — the reducer every write goes through; `completeEntry` (id, `provenance.at`, tag normalization); `coerceEntry` (validation of foreign rows with a dropped-fields report) |
| `src/store` | `createMemoryStore({ state, now, commit })` — the `MemoryStore` contract over a state and a commit hook; `memoryPlugin()` — the default plugin with an in-memory backend |
| `src/export` | versioned NDJSON: `toNdjson` / `exportToString` / `fromNdjson` / `parseExportHeader` |
| `src/testing` | `memoryConformance(make)` — the suite every backend runs (`@agentic/memory/testing`) |

## Semantics

- `query` never returns more than `limit` entries nor more than `maxBytes` bytes of `text`; an entry that does not fit is skipped, not a stop. `tags` (any-of, case-insensitive; a token of `conditions` counts as a tag), `kinds`, `subject` and `since` filter; `text` ranks. Without text, kind weight and recency still order the result.
- `working` entries with a `ttl` expire `ttl` ms after `provenance.at`; expired ones never come back from `query` and are compacted away on the next `working` put or `compact()`.
- `record` entries are compacted per task: a new record for a `taskId` retires the previous ones and `supersedes` the latest.
- `retire` is a soft delete: hidden from `query`, still readable through `get` (flagged `retired`) and exported.
- Export is NDJSON with a header line `{ format: 'agentic-memory', version: 1, scope?, exportedAt }`; a reader refuses unknown formats and versions. `import` reports `imported`, `skipped` (invalid rows, or an existing id with `onConflict: 'skip'`, the default) and `droppedFields` (fields the entry shape cannot hold, dotted for `provenance.*`).

## Conformance

```ts
import { memoryConformance } from '@agentic/memory/testing';
for (const c of memoryConformance((scope) => plugin.open(scope, ctx))) it(c.name, c.run);
```

No test-runner import; `make` returns a fresh, empty store per scope.
