/**
 * Approval policy compilation (AGT-04, COL-10, AC-12): `ApprovalRule`s and
 * `ToolGrant`s as a `@sigx/ai-agent` `Policy`, constrained across
 * delegation. Lives here — below `@agentic/platform` — so the machine daemon
 * compiles the SAME session policy from the rules an `OpenSpec` carries
 * (#121); the platform re-exports it for the local path.
 */
export { agentPolicy, compilePolicy, constrainPolicy, grantPolicy, ruleMatches, sessionPolicy, sessionPolicyOf } from './compile.js';
