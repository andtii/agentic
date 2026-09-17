# Changelog

All notable changes to `@agentic/memory` (Keep a Changelog, semver).

## [Unreleased]

- Migration between plugins (#49, MEM-09): the flat plugin (`flatMemoryPlugin()` / `createFlatMemoryStore()` under `src/plugins/flat`, `capabilities.export: 'partial'`, no `conditions` / `evidence` / `supersedes` / `ttl`, substring retrieval), `migrate(from, to, { dryRun, onConflict })` → `MigrationReport` with the dropped fields and counts per entry kind, the `fidelity(entry)` seam on both stores (`MemoryFidelity`), `memoryConformance(make, { without })` with `requires: MemoryFeature[]` per case, and a fix: a record put already retired (an import) no longer supersedes the live record of its task.

- Default MemoryPlugin (#26): pure ranking core (BM25-ish over text/tags/subject/conditions, kind + confidence weights, recency decay, `limit` / `maxBytes` budget), `MemoryState` + `applyMemoryLog` reducer (working ttl, per-task record compaction, soft retire), `createMemoryStore` over a state + commit hook, `memoryPlugin()` with an in-memory backend, versioned NDJSON export/import with a fidelity report, and `memoryConformance(make)` under `@agentic/memory/testing`.
