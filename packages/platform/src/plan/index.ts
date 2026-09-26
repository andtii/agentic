/**
 * Plan — a project's plans, items, queues, claims and leases, enforced server-side (#750; PRJ-11).
 *
 * - `key.ts`: `planKey(ws, projectId)` → `{ws}:plan:{projectId}`.
 * - `rules.ts`: the pure rules every method runs through (table-tested).
 * - `actor.ts`: `definePlanActor()` — the store, the lease alarm, notices and History.
 * - `links.ts`: cross-project `after` (`project#n`), blocked following the other project's item, and the workspace's
 *   link graph (`workspaceLinks` over each project's `linkItems`) (#764, #822).
 * - `port.ts`: the actor as the `plan_*` tools' `PlanPort` (#816), and the pieces the MCP surface shares.
 * - `settings.ts`: the Plan feature's project settings the actor enforces (#938).
 * - `wake.ts`: how a notice wakes its addressee — a chat message for an agent, an Inbox row for a person (#938).
 */
export * from './key.js';
/** The pure rules, namespaced: their names (`claim`, `update`, …) are too plain for the package surface. */
export * as planRules from './rules.js';
export { PlanRuleError, LEASE_MAX_MS as PLAN_LEASE_MAX_MS, LEASE_MIN_MS as PLAN_LEASE_MIN_MS } from './rules.js';
export type { ClaimOptions as PlanClaimOptions, HandoffOptions as PlanHandoffOptions, OpenPlanItem, PlanCreateInput, PlanErrorCode, PlanItemInput, PlanItemPatch, PlanNotice, PlanOp, TouchesWarning as PlanTouchesWarning } from './rules.js';
export * from './links.js';
export * from './actor.js';
export type { PlanChangedData } from '../audit/events.js';
export * from './port.js';
export * from './settings.js';
export * from './wake.js';
