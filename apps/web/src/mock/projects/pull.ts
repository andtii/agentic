/**
 * Mock data for the pull request page (#722) — owned by #744, imported only by its own page; nothing shared re-exports it.
 * Empty until then (#725).
 */
import type { PullRequest } from '@agentic/core';

/** Pull requests by project id. */
export const MOCK_PULLS: Readonly<Record<string, readonly PullRequest[]>> = {};
