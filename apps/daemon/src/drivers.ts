/**
 * The runtime drivers this daemon build ships — the registration point. The
 * daemon consumes only the `@agentic/core` `RuntimeDriver` seam and picks a
 * driver by `environment.runtime`; nothing else here knows a runtime.
 */

import type { QuotaSource } from '@agentic/core';
import { openMcpConnector } from '@agentic/mcp';
import { openStdioMcpConnector } from '@agentic/mcp/node';
import { claudeCodeDriver, claudeCodeQuota, type DaemonConnectorOpener } from '@agentic/runtimes/claude-code';
import { copilotCliDriver, copilotCliQuota } from '@agentic/runtimes/copilot-cli';
import type { DaemonDriver } from './daemon.js';

/** A driver that holds processes or agents to release when the daemon stops. */
export type DisposableDriver = DaemonDriver & { dispose(): Promise<void> };

/**
 * How this daemon opens an agent's MCP connectors (#280): stdio servers as child processes (allowlisted
 * environment plus the connector's credential variables), Streamable HTTP ones over `fetch`.
 */
export const openConnector: DaemonConnectorOpener = (c) => {
    if (c.transport === 'stdio') {
        if (c.command === undefined) return Promise.reject(new Error('a stdio connector needs a command'));
        return openStdioMcpConnector({ id: c.id, command: c.command, ...(c.args ? { args: c.args } : {}), ...(c.cwd !== undefined ? { cwd: c.cwd } : {}), ...(c.env ? { env: c.env } : {}) });
    }
    if (c.url === undefined) return Promise.reject(new Error('a Streamable HTTP connector needs a URL'));
    return openMcpConnector({ id: c.id, url: c.url, ...(c.bearer !== undefined ? { bearer: c.bearer } : {}), ...(c.headers ? { headers: c.headers } : {}) });
};

/** What this build ships: a driver per runtime, and the `quota` source each reads provider limits with (#271). */
export interface BuiltinRuntimes {
    readonly drivers: DaemonDriver[];
    readonly quotaSources: QuotaSource[];
}

/**
 * Claude Code, Copilot CLI (#321). A source that asks the runtime itself shares its driver, so a usage probe
 * reuses the Copilot runtime a session would start, not a second one per environment.
 */
export function builtinRuntimes(): BuiltinRuntimes {
    const copilot = copilotCliDriver({ connectors: openConnector });
    return {
        drivers: [claudeCodeDriver({ connectors: openConnector }), copilot],
        quotaSources: [claudeCodeQuota(), copilotCliQuota({ client: (env) => copilot.clientFor(env) })]
    };
}

export function builtinDrivers(): DaemonDriver[] {
    return builtinRuntimes().drivers;
}

/** The `quota` sources this build ships, one per runtime (#271): what the daemon reads provider limits with. */
export function builtinQuotaSources(): QuotaSource[] {
    return builtinRuntimes().quotaSources;
}

export function isDisposable(driver: DaemonDriver): driver is DisposableDriver {
    return typeof (driver as Partial<DisposableDriver>).dispose === 'function';
}
