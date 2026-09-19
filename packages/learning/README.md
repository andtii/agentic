# @agentic/learning

Default LearningPlugin: corrections and verified outcomes become lessons with evidence and conditions.

Works over any `MemoryStore` (`@agentic/core`), so it runs unchanged against the in-memory store and the Memory actor.

```ts
import { learningPlugin, relevantLessons } from '@agentic/learning';

const learning = learningPlugin({
    ledger,                                   // CorrectionLedger — LRN-09 counters (default: in-memory)
    contextFor: (c) => ({ objective, tags }), // the task a correction belongs to → lesson conditions
});

await learning.onCorrection(correction, memory); // lesson written, proposals returned
await learning.onTaskEnd(outcome, memory);       // record written (+ lesson if a claim was refuted)

const lessons = await relevantLessons(memory, { objective: 'deploy the docs site' }); // before the next task
```

- **Corrections → lessons** (LRN-04): `text` is what was learned, `evidence` one line per correction (who, when, session/message, wording), `conditions` the task it came from. User corrections are `confidence: 'stated'`, `provenance.source: 'user'`. Agent-detected corrections are ignored unless `acceptAgentCorrections: true`, and then only `assumed`.
- **Repeats supersede** (LRN-06): a correction of the same kind with ≥ 0.6 word overlap replaces the earlier lesson (`supersedes`, old one retired) and accumulates its evidence — the newest `evidenceCap` lines behind a `corrections in total: N` line the cap never trims. `retireLesson` / `supersedeLesson` do the same by hand.
- **Outcomes** (LRN-02/03): every task end is a `record`; `verified` / `refuted` outcomes are `confidence: 'verified'`, `source: 'verification'`, claimed ones `assumed` / `agent`, and the tags say which. A refuted claim is also a lesson.
- **Retrieval** (LRN-05): `relevantLessons` ranks lessons on the objective and tags, drops lessons sharing no word with them and never returns a retired lesson.
- **Controlled adaptation** (LRN-08): a user correction repeated `repeatThreshold` times (default 3) yields `{ kind: 'instruction', patch, reason, requiresReview: true }` — never applied, never a permission. `assertPermissionFree` (runtime) and `PermissionFree<T>` (type level) reject any proposal carrying a permission key or a field outside the contract; `applyProposals` checks the whole batch before writing anything.
- **Counters** (LRN-09): `CorrectionLedger.recordCorrection({ agentId, week, what, at })` per ISO week (UTC); the platform Ledger implements it, `memoryCorrectionLedger()` is the dev backend.
- **Manifest** (#228, PLG-02): `learningDefaultPlugin` is the `PluginManifest` of `learningPlugin()` (same id and version) for the composition root's catalogue — kind `learning` (single-slot), `memory:read` + `memory:write`, no secrets, no config yet.

Design: `docs/architecture.md` §8. What may move into the sigx estate later: `docs/promotion.md`.
