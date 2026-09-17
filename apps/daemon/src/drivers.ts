/**
 * The runtime drivers this daemon build ships. The daemon consumes only the
 * `@agentic/core` `RuntimeDriver` seam and picks a driver by
 * `environment.runtime`; nothing else here knows a runtime.
 *
 * Registration point: the Claude Code driver (`@agentic/runtimes`
 * `claude-code`, issue #20) is added to `builtinDrivers` when it lands.
 * Until then an environment with `"runtime": "claude-code"` is reported by
 * `doctor` as having no driver and is left out of `hello`.
 */

import type { DaemonDriver } from './daemon.js';

export function builtinDrivers(): DaemonDriver[] {
    return [];
}
