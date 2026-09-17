# Changelog

All notable changes to `@agentic/memory` (Keep a Changelog, semver).

## [Unreleased]

- Default MemoryPlugin (#26): pure ranking core (BM25-ish over text/tags/subject/conditions, kind + confidence weights, recency decay, `limit` / `maxBytes` budget), `MemoryState` + `applyMemoryLog` reducer (working ttl, per-task record compaction, soft retire), `createMemoryStore` over a state + commit hook, `memoryPlugin()` with an in-memory backend, versioned NDJSON export/import with a fidelity report, and `memoryConformance(make)` under `@agentic/memory/testing`.
