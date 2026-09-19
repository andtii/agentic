# Changelog

All notable changes to `@agentic/memory` (Keep a Changelog, semver).

## [Unreleased]

- The flat store over a host's state (#281): `createFlatMemoryStore({ state })` reads and writes a `FlatMemoryState` (`createFlatMemoryState()`: plain, JSON-safe `entries` / `retirements` records) in place, so a host can persist it — the platform's FlatMemory actor does; `exportPage(after, size)` pages the entries by id (`FLAT_EXPORT_PAGE` = 100). Lookups read own properties only, and an import row whose id a record cannot hold (`__proto__`, `constructor`, `prototype`) is skipped. New exports: `createFlatMemoryState`, `FLAT_EXPORT_PAGE`, `FlatMemoryState`, `FlatRetirement`.
- Config (#242): both memory manifests declare `retrievalLimit` (integer 0–50, default 8 — the platform's session-start budget); the platform applies it to whichever memory plugin is active.
- Plugin manifests (#228, PLG-02): `memoryDefaultPlugin` (`agentic.memory.default`), `memoryFlatPlugin` (`agentic.memory.flat`) and `MEMORY_PLUGINS` (default first) — kind `memory`, `memory:read` + `memory:write`, no config yet. Declarations only.
- Delete (#149, MEM-05 / MEM-08): `MemoryLogEntry` gains `{ op: 'delete', id }` — `applyMemoryLog` drops the entry and its retirement; `createMemoryStore().delete(id)` and the flat store's `delete(id)` resolve `false` for an unknown id; `memoryConformance` gains a core case (gone from `get`, `query`, `export`).

- Migration between plugins (#49, MEM-09): the flat plugin (`flatMemoryPlugin()` / `createFlatMemoryStore()` under `src/plugins/flat`, `capabilities.export: 'partial'`, no `conditions` / `evidence` / `supersedes` / `ttl`, substring retrieval), `migrate(from, to, { dryRun, onConflict })` → `MigrationReport` with the dropped fields and counts per entry kind, the `fidelity(entry)` seam on both stores (`MemoryFidelity`), `memoryConformance(make, { without })` with `requires: MemoryFeature[]` per case, and a fix: a record put already retired (an import) no longer supersedes the live record of its task.

- Default MemoryPlugin (#26): pure ranking core (BM25-ish over text/tags/subject/conditions, kind + confidence weights, recency decay, `limit` / `maxBytes` budget), `MemoryState` + `applyMemoryLog` reducer (working ttl, per-task record compaction, soft retire), `createMemoryStore` over a state + commit hook, `memoryPlugin()` with an in-memory backend, versioned NDJSON export/import with a fidelity report, and `memoryConformance(make)` under `@agentic/memory/testing`.
