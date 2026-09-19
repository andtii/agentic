# Changelog

All notable changes to `@agentic/learning` (Keep a Changelog, semver).

## [Unreleased]

- Plugin manifest (#228, PLG-02): `learningDefaultPlugin` (`agentic.learning.default`) — kind `learning`, `memory:read` + `memory:write`, no config yet. A declaration only.
- Package skeleton.
- `learningPlugin()` — the default `LearningPlugin`: corrections become lessons with evidence, conditions and user provenance; repeated corrections supersede the earlier lesson; task outcomes become records with claimed and verified success kept distinct; refuted claims become lessons; agent-detected corrections off by default (#27).
- `relevantLessons`, `retireLesson`, `supersedeLesson` — retrieval before similar tasks and revision; retired lessons never returned.
- Instruction proposals (`requiresReview: true`) for corrections repeated `repeatThreshold` times; `assertPermissionFree` / `PermissionFree<T>` / `applyProposals` guarantee no proposal carries a permission.
- `CorrectionLedger` port + `isoWeek` + `memoryCorrectionLedger()` — corrections per agent per ISO week (LRN-09).
