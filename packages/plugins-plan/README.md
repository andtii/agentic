# @agentic/plugins-plan

The plan project feature plugin (PRJ-11): plans of phases and items carried out
by tasks, with assignment queues, claims with a lease, working limits, `after`
dependencies and touched paths. Edge-safe, depends on `@agentic/core` only.

Design: `docs/architecture.md` §10 "Projects (redesign)".

Exports (#753): `planFeaturePlugin` / `planFeatureManifest` (`agentic.feature.plan`,
category `planning`; the Plan section with open items counted, the overview card,
the Ready/Do/Review/Done work stages, the `#` ref prefix and the `plan` tool
family), the project settings (agents may tick items, claim limit, lease, starter
plan, instructions), `PLAN_PRESETS` (Blank, Event day (20 items), Release
(12 items)), the starter `PLAN_TEMPLATES`, and `planInstructions()` — the plan
tools, the ref syntax and the project's limits for every session's Project section.
The plan store and the tool handlers live with the Plan actor and the `plan` tool
family.
