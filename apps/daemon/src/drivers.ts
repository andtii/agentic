/**
 * The runtime drivers this daemon build ships — the registration point. The
 * daemon consumes only the `@agentic/core` `RuntimeDriver` seam and picks a
 * driver by `environment.runtime`; nothing else here knows a runtime.
 *
 * With a harness locator (#369) each driver runs the executable of its runtime's
 * installed harness (`harness.ts`): Claude Code through `pathToClaudeCodeExecutable`,
 * Copilot through the SDK's stdio connection to `copilot-runtime`, Codex through
 * `codexPath`. A runtime without one is still registered, as `harnessMissingDriver`:
 * its environments report `harness-missing` and a session on them is refused so.
 */

import type { DoctorReport, LocalEnvironment, QuotaSource } from '@agentic/core';
import { openMcpConnector } from '@agentic/mcp';
import { openStdioMcpConnector } from '@agentic/mcp/node';
import { CLAUDE_CODE_QUOTA_ID, CODEX_CLI_QUOTA_ID, COPILOT_CLI_QUOTA_ID, QUOTA_SOURCE_VERSION } from '@agentic/runtimes';
import { claudeCodeDriver, claudeCodeQuota, type DaemonConnectorOpener } from '@agentic/runtimes/claude-code';
import { codexCliDriver, codexCliQuota } from '@agentic/runtimes/codex-cli';
import { copilotCliDriver, copilotCliQuota, loadCopilotClient } from '@agentic/runtimes/copilot-cli';
import type { DaemonDriver } from './daemon.js';
import { HarnessMissingError, type HarnessLocator } from './harness.js';

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
    /** The drivers as built; after a harness change `current()` has the rebuilt one. */
    readonly drivers: DaemonDriver[];
    /** One per runtime; each asks whichever driver of its runtime is current. */
    readonly quotaSources: QuotaSource[];
    /** Build `runtime`'s driver again from where its harness is now (#369) — after an install, update or removal. */
    rebuild(runtime: string): DaemonDriver | undefined;
    /** The drivers now. */
    current(): DaemonDriver[];
}

export interface BuiltinRuntimesOptions {
    /**
     * Where each runtime's harness is (#369). Absent: every SDK finds its native build its own way (beside it in
     * `node_modules`) — what a caller that manages no harnesses gets.
     */
    readonly harnesses?: HarnessLocator;
}

/**
 * The driver of a runtime whose harness is not installed (#369): registered all the same, so its environments are
 * reported — with an `unknown` sign-in, no capabilities and a `harness-missing` doctor verdict — and `open` throws
 * `HarnessMissingError`, which the daemon answers with `session.closed { code: 'harness-missing' }`.
 */
export function harnessMissingDriver(runtime: string): DaemonDriver {
    const reason = new HarnessMissingError(runtime).message;
    return {
        runtime,
        async inspect() {
            return { authStatus: 'unknown', isolation: 'none', capabilities: { runtime, supported: [], unsupported: [{ op: '*', reason }], resume: false, cancel: false, steer: false, permissions: 'none', tools: 'none' } };
        },
        async open() {
            throw new HarnessMissingError(runtime);
        },
        async doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport> {
            return { ok: false, findings: [{ level: 'error', code: 'harness-missing', message: reason, environmentIds: envs.map((e) => e.id) }] };
        }
    };
}

type Built = { readonly driver: DaemonDriver; readonly quota?: QuotaSource };

/**
 * Claude Code, Copilot CLI, Codex (#321). A source that asks the runtime itself goes through its driver: the
 * Copilot probe reuses the runtime a session would start, the Codex probe opens the app-server the driver would.
 */
export function builtinRuntimes(options: BuiltinRuntimesOptions = {}): BuiltinRuntimes {
    const { harnesses } = options;
    /** Where `runtime` runs from: `null` when a locator finds none, `undefined` when there is no locator (the SDK's default). */
    const where = (runtime: string): string | null | undefined => {
        if (!harnesses) return undefined;
        return harnesses.locate(runtime)?.binary ?? null;
    };
    const quotaIds: Record<string, string> = { 'claude-code': CLAUDE_CODE_QUOTA_ID, 'copilot-cli': COPILOT_CLI_QUOTA_ID, 'codex-cli': CODEX_CLI_QUOTA_ID };
    const build: Record<string, () => Built> = {
        'claude-code': () => {
            const binary = where('claude-code');
            if (binary === null) return { driver: harnessMissingDriver('claude-code') };
            const at = binary !== undefined ? { pathToClaudeCodeExecutable: binary } : {};
            return { driver: claudeCodeDriver({ connectors: openConnector, ...at }), quota: claudeCodeQuota(at) };
        },
        'copilot-cli': () => {
            const binary = where('copilot-cli');
            if (binary === null) return { driver: harnessMissingDriver('copilot-cli') };
            const copilot = copilotCliDriver({ connectors: openConnector, ...(binary !== undefined ? { createClient: (init) => loadCopilotClient({ ...init, cliPath: binary }) } : {}) });
            return { driver: copilot, quota: copilotCliQuota({ client: (env) => copilot.clientFor(env) }) };
        },
        'codex-cli': () => {
            const binary = where('codex-cli');
            if (binary === null) return { driver: harnessMissingDriver('codex-cli') };
            const codex = codexCliDriver({ connectors: openConnector, ...(binary !== undefined ? { codexPath: binary } : {}) });
            return { driver: codex, quota: codexCliQuota({ connect: codex.connect }) };
        }
    };
    const current = new Map<string, Built>(Object.entries(build).map(([runtime, make]) => [runtime, make()]));
    // A stable source per runtime over whichever build is current: the daemon's quota monitor keeps the list it was given.
    const quotaSources: QuotaSource[] = [...current.keys()].map((runtime) => ({
        id: quotaIds[runtime]!,
        version: QUOTA_SOURCE_VERSION,
        runtime,
        probe: async (env, ctx) => (await current.get(runtime)?.quota?.probe?.(env, ctx)) ?? null,
        fromSignal: (signal, env) => current.get(runtime)?.quota?.fromSignal?.(signal, env) ?? null
    }));
    return {
        drivers: [...current.values()].map((b) => b.driver),
        quotaSources,
        rebuild(runtime) {
            const make = build[runtime];
            if (!make) return undefined;
            const next = make();
            current.set(runtime, next);
            return next.driver;
        },
        current: () => [...current.values()].map((b) => b.driver)
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
