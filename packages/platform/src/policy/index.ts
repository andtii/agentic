/** Approval policy compilation — `ApprovalRule`s and `ToolGrant`s as a `@sigx/ai-agent` `Policy`, constrained across delegation (AGT-04, COL-10, AC-12) — and the request / grant views over a session log (OPS-02, CHT-09). */
export { agentPolicy, compilePolicy, constrainPolicy, grantPolicy, ruleMatches, sessionPolicy } from './compile.js';
export type { RequestEvent, RequestResolvedEvent, RequestNeed, SessionGrant, RequestRecord } from './requests.js';
export { needOf, requestRef, parseRequestRef, permissionKeyOf, sessionGrantsOf, requestRecordOf, requestRecordsOf, policyRequestOf, ruleFor, describeRule } from './requests.js';
