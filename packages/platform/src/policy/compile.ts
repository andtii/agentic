/**
 * The compile lives in `@agentic/runtimes` (`packages/runtimes/src/policy`,
 * #121) so the machine daemon runs the same code over the rules an
 * `OpenSpec` carries; the platform re-exports it here for the local path.
 */
export { agentPolicy, compilePolicy, constrainPolicy, grantPolicy, ruleMatches, sessionPolicy, sessionPolicyOf } from '@agentic/runtimes';
