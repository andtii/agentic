/**
 * The runtime drivers this daemon build ships — the registration point. The
 * daemon consumes only the `@agentic/core` `RuntimeDriver` seam and picks a
 * driver by `environment.runtime`; nothing else here knows a runtime.
 */

import type { QuotaSource } from '@agentic/core';
import { claudeCodeDriver, claudeCodeQuota } from '@agentic/runtimes/claude-code';
import type { DaemonDriver } from './daemon.js';

/** A driver that holds processes or agents to release when the daemon stops. */
export type DisposableDriver = DaemonDriver & { dispose(): Promise<void> };

export function builtinDrivers(): DaemonDriver[] {
    return [claudeCodeDriver()];
}

/** The `quota` sources this build ships, one per runtime (#271): what the daemon reads provider limits with. */
export function builtinQuotaSources(): QuotaSource[] {
    return [claudeCodeQuota()];
}

export function isDisposable(driver: DaemonDriver): driver is DisposableDriver {
    return typeof (driver as Partial<DisposableDriver>).dispose === 'function';
}
