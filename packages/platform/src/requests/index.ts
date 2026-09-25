/**
 * Requests — work moving between projects, triaged by the receiving project's manager (#758; PRJ-14/PRJ-15).
 *
 * - `key.ts`: `requestsKey(ws, projectId)` → `{ws}:requests:{projectId}`.
 * - `rules.ts`: the pure state machine every method runs through (table-tested).
 * - `actor.ts`: `defineRequestsActor()` — the store, the triage turn, the plan item on accept, the audit.
 */
export * from './key.js';
/** The pure rules, namespaced: their names (`receive`, `triage`, …) are too plain for the package surface. */
export * as requestRules from './rules.js';
export { RequestRuleError, whyText as requestWhyText } from './rules.js';
export type { RequestAskReason, RequestErrorCode, RequestInput, RequestOp, RequestResolution, RequestView } from './rules.js';
export * from './actor.js';
export type { RequestChangedData } from '../audit/events.js';
