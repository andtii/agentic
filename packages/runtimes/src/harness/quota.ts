/** Shared by every runtime's usage-limits source. */

import type { QuotaStatus } from '@agentic/core';

/** From here a window reads as `warning` when the provider did not say. */
export const QUOTA_WARNING_AT = 0.8;

/** A 0..1 utilization's status: `unknown` without a number, `exhausted` at 1. */
export const quotaStatusOf = (utilization: number | null): QuotaStatus => (utilization === null ? 'unknown' : utilization >= 1 ? 'exhausted' : utilization >= QUOTA_WARNING_AT ? 'warning' : 'ok');
