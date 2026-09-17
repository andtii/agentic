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
| `src/plugins/flat` | `flatMemoryPlugin()` / `createFlatMemoryStore()` — the deliberately narrower second plugin (MEM-09): tags only, substring retrieval, `capabilities.export: 'partial'` |
| `src/migrate` | `migrate(from, to, { dryRun })` → `MigrationReport` — the defined path between two stores, with the dropped fields per entry kind |
| `src/testing` | `memoryConformance(make, { without })` — the suite every backend runs (`@agentic/memory/testing`) |

## Semantics

- `query` never returns more than `limit` entries nor more than `maxBytes` bytes of `text`; an entry that does not fit is skipped, not a stop. `tags` (any-of, case-insensitive; a token of `conditions` counts as a tag), `kinds`, `subject` and `since` filter; `text` ranks. Without text, kind weight and recency still order the result.
- `working` entries with a `ttl` expire `ttl` ms after `provenance.at`; expired ones never come back from `query` and are compacted away on the next `working` put or `compact()`.
- `record` entries are compacted per task: a new record for a `taskId` retires the previous ones and `supersedes` the latest.
- `retire` is a soft delete: hidden from `query`, still readable through `get` (flagged `retired`) and exported.
- Export is NDJSON with a header line `{ format: 'agentic-memory', version: 1, scope?, exportedAt }`; a reader refuses unknown formats and versions. `import` reports `imported`, `skipped` (invalid rows, or an existing id with `onConflict: 'skip'`, the default) and `droppedFields` (fields the entry shape cannot hold, dotted for `provenance.*`).

## Migration and fidelity (MEM-09)

Two plugins ship here. The default one holds every field of `MemoryEntry` and declares `capabilities.export: 'full'`. The **flat** plugin (`flatMemoryPlugin()`, id `agentic.memory.flat`) is the narrower second implementation — the one a migration is proven against — and declares `capabilities.export: 'partial'`:

| | default | flat |
|---|---|---|
| Entry fields | all of `MemoryEntry` | id, kind, text, tags, subject, provenance, confidence, retired |
| Dropped on the way in | — | `conditions`, `evidence`, `supersedes`, `ttl` (`FLAT_UNSUPPORTED_FIELDS`) |
| Retrieval | BM25 over text/tags/subject/conditions × kind, confidence, recency | count of query terms found as substrings of `text`; ties by recency, then id — no kind or confidence weight |
| Filters | `tags` (conditions tokens count), `kinds`, `subject`, `since`, `limit` / `maxBytes` | the same, but `tags` are the tags only |
| `working` expiry | `ttl` ms after `provenance.at` | never — `ttl` is dropped, the entry stays until retired |
| Records per task | newest supersedes and retires the rest | every record stays live; `supersedes` is dropped |
| Lost fields | reported by `import` | reported by `import`, by `fidelity(entry)`, and logged (`warn`) by a `put` / `update` that carried one |

```ts
import { createFlatMemoryStore, createMemoryStore, migrate } from '@agentic/memory';
const report = await migrate(defaultStore, flatStore, { dryRun: true });
// { dryRun: true, entries: 7, imported: 7, skipped: 0,
//   droppedFields: ['conditions', 'evidence', 'supersedes', 'ttl'],
//   kinds: { lesson: { entries: 1, imported: 1, skipped: 0, droppedFields: ['conditions', 'evidence'] },
//            record: { entries: 2, imported: 2, skipped: 0, droppedFields: ['supersedes'] },
//            working: { entries: 1, imported: 1, skipped: 0, droppedFields: ['ttl'] }, fact: { …, droppedFields: [] }, … } }
```

`migrate` exports everything from `from` (retired entries included), imports it into `to` kind by kind and returns one `MigrationKindReport` per kind present plus the totals; `droppedFields` are sorted and dotted for `provenance.*`, and a field is listed only when an entry of that kind actually carried it. A dry run writes nothing: it asks the target's `fidelity(entry)` seam (every store of this package has one; `MemoryFidelity`) and `get` for id conflicts, and produces the same numbers as the real run. A target without the seam — a store from another package — migrates for real only (`MemoryMigrationError` on `dryRun`). `onConflict` is `import`'s: `'skip'` (default) counts an existing id as skipped, `'replace'` overwrites.

Known limitations of the round trip default → flat → default: exactly the four fields above come back missing, nothing else (AC-11). Consequences on the way back: a `working` entry without `ttl` never expires, a superseded record keeps `retired: true` but loses its `supersedes` link, a lesson loses its `conditions` (so it no longer matches a tags query by them) and its `evidence`. Retirement reasons are not part of `MemoryEntry` and so not of any export — both plugins keep them (`state.retirements` / `retirement(id)`), neither migrates them.

## Conformance

```ts
import { memoryConformance } from '@agentic/memory/testing';
for (const c of memoryConformance((scope) => plugin.open(scope, ctx))) it(c.name, c.run);
// a narrower plugin: leave out the cases for the features it lacks
for (const c of memoryConformance(make, { without: ['conditions', 'kindWeights', 'ttl', 'supersedes'] })) it(c.name, c.run);
```

No test-runner import; `make` returns a fresh, empty store per scope. Every case carries `requires: MemoryFeature[]` — empty for the core every plugin must pass (put/get/update/retire, filters, `limit` / `maxBytes`, recency, versioned export, lossless same-plugin import, the import fidelity report), one of `MEMORY_FEATURES` for the four cases a plugin may opt out of by reporting the field instead (MEM-09). The flat plugin runs with all four left out; the default plugin and the Memory actor run the whole suite.
