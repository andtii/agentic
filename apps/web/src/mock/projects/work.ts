/**
 * Mock data for the Work view (#722) — owned by #738, imported only by its own page; nothing shared re-exports it.
 * Empty until then (#725).
 */
import type { WorkItem } from '@agentic/core';

/** Work items by project id. */
export const MOCK_WORK: Readonly<Record<string, readonly WorkItem[]>> = {};
