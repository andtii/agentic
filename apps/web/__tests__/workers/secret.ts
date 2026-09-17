/** Test-only signing secret; real deployments use `wrangler secret put SESSION_SECRET`. */
export const TEST_SESSION_SECRET = 'workers-test-session-secret-0123456789abcdef';

/** Test-only 256-bit key; real deployments use `wrangler secret put WORKSPACE_KEK`. */
export const TEST_WORKSPACE_KEK = 'orzrrWk7ncRCZbWL_Dza3vPV_5M7qcDn66zyydXWFto';

/** Test-only dev-login token (#35); a preview deployment sets `wrangler secret put AGENTIC_DEV_LOGIN --env preview`. */
export const TEST_DEV_LOGIN = 'workers-test-dev-login-token-0123456789';
