/**
 * `claudeCodeDriver` — the `RuntimeDriver` for daemon-hosted Claude Code
 * (architecture §5b).
 *
 * One `claudeCode()` agent per environment, isolated by its own
 * `CLAUDE_CONFIG_DIR` and nothing inherited that could pick another account:
 * the parent's `CLAUDE_CONFIG_DIR` and `ANTHROPIC_*` variables are removed
 * from the child environment unless the environment sets them (EXE-04/05).
 * Sessions append the platform's system prompt to Claude Code's preset, run
 * the platform tools the spec names as client tools bridged back through
 * `callTool`, open the agent's MCP connectors the spec carries beside them
 * (#280, `connectors.ts`), and report their capabilities (AGT-09).
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { query as sdkQuery, type SpawnOptions, type SpawnedProcess, type PermissionMode, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentSession, ConfigValue, Policy, SessionRef } from '@sigx/ai-agent';
import { CLAUDE_CODE_CAPABILITIES, claudeCode, spawnForSdk, type ClaudeCodeSessionOptions, type ListenFn, type ListSessionsFn, type QueryFn } from '@sigx/ai-agent-claude-code';
import { BYPASS_PERMISSIONS_MODE, type DoctorReport, type EnvironmentInspection, type LocalEnvironment, type ModelOption, type OpenedRuntimeSession, type OpenSpec, type RuntimeDriver, type RuntimeOpenContext } from '@agentic/core';
import { readProfileAuth, type ProfileAuthDeps } from './auth.js';
import { claudeCodeCapabilityReport } from './capabilities.js';
import { openDaemonConnectors, withConnectorPolicy, type DaemonConnectorOpener } from '../harness/connectors.js';
import { assertCwdInRoots, assertRuntime as assertRuntimeOf, closingWith } from '../harness/session.js';
import { bridgedPlatformTools } from '../harness/tools.js';
import { claudeCodeDoctor, type DoctorInput } from './doctor.js';
import { accountEnv } from './env.js';
import { claudeCodeModels, type ModelsQueryFn } from './models.js';
import { sessionPids } from './pids.js';
import { withPlanReview } from './plan.js';
import { claudeCodeSystemPrompt, withUnavailableConnectors } from './system.js';
import { readSessionTitle } from './title.js';

export interface ClaudeCodeDriverOptions {
    /** The SDK's `query`; a fake in tests. */
    readonly query?: QueryFn;
    readonly listen?: ListenFn;
    readonly listSessions?: ListSessionsFn;
    /** How the CLI process is spawned; `@sigx/ai-agent-node`'s supervised spawn by default. */
    readonly spawn?: (options: SpawnOptions) => SpawnedProcess;
    readonly pathToClaudeCodeExecutable?: string;
    /** The models a session may switch to; the adapter's list by default. */
    readonly models?: readonly ConfigValue[];
    /** Default `'default'`: every non-trivial tool call asks, and the policy answers. */
    readonly permissionMode?: PermissionMode;
    /** The daemon's own environment, whose account variables are kept out of every child. Default `process.env`. */
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    /** Where Claude Code keeps its config without `CLAUDE_CONFIG_DIR`. Default the user's home. */
    readonly home?: string;
    /** Profile file reads and the clock, for `inspect`; the real file system by default. */
    readonly auth?: Partial<ProfileAuthDeps>;
    /**
     * Opens an MCP connector as tools (#280) — `@agentic/mcp`'s openers, wired by the daemon. Absent: the spec's
     * connectors are left out of every session, and the agent is told why.
     */
    readonly connectors?: DaemonConnectorOpener;
    /** The SDK's `query` for `models(env)`'s unprompted probe; a fake in tests. */
    readonly modelsQuery?: ModelsQueryFn;
}

export interface ClaudeCodeDriver extends RuntimeDriver<AgentSession, Policy> {
    /** The agent every session of `env` runs on — the same instance `open` uses. */
    agentFor(env: LocalEnvironment): Agent<ClaudeCodeSessionOptions>;
    /** The config dir the CLI uses for `env`. */
    configDirOf(env: LocalEnvironment): string;
    /** Dispose every agent and terminate every CLI process. */
    dispose(): Promise<void>;
}

const RUNTIME = 'claude-code';

/**
 * The setting sources a session loads: the repository's own (`CLAUDE.md` and its imports,
 * `.claude/settings.json`, hooks, skills) from `cwd` upward — what the interactive CLI reads in
 * that folder (#461). `user` and `local` stay out: the account lives in `CLAUDE_CONFIG_DIR`, not in
 * settings, and nothing of the daemon operator's own `~/.claude` reaches an agent (decision 3).
 */
export const SETTING_SOURCES: readonly SettingSource[] = ['project'];

/**
 * Claude Code's own cross-session tools: they list and message OTHER Claude Code sessions on the
 * machine — the operator's own work, not this platform's agents. A platform session reaches its
 * collaborators through `delegate` / `chat_post`. Claude Code runs these without asking (no
 * permission request reaches the policy), so they are taken out of the model's context instead:
 * the SDK's `disallowedTools`.
 */
export const CROSS_SESSION_TOOLS: readonly string[] = ['ListAgents', 'SendMessage'];

/** `query` with Claude Code's cross-session tools disallowed on every session it starts, beside any the caller disallows. */
export function withoutCrossSessionTools(query: QueryFn): QueryFn {
    const wrapped = (params: Parameters<QueryFn>[0]) =>
        query({ ...params, options: { ...params.options, disallowedTools: [...new Set([...(params.options?.disallowedTools ?? []), ...CROSS_SESSION_TOOLS])] } });
    return wrapped as QueryFn;
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return undefined;
        throw e;
    }
}

const joinPath = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`;

export function claudeCodeDriver(options: ClaudeCodeDriverOptions = {}): ClaudeCodeDriver {
    const agents = new Map<string, Agent<ClaudeCodeSessionOptions>>();
    const home = () => options.home ?? homedir();
    const authDeps: ProfileAuthDeps = {
        readText: options.auth?.readText ?? readText,
        platform: options.auth?.platform ?? process.platform,
        now: options.auth?.now ?? Date.now
    };

    const assertRuntime = (env: LocalEnvironment) => assertRuntimeOf(RUNTIME, env);

    /**
     * Each session's CLI process (#400), charged to it by the spawn that starts it. The adapter's own default spawn is
     * kept as is for a `.cmd` shim (it resolves the shim first, asynchronously — the daemon never passes one: it names
     * `claude(.exe)` itself); every other case spawns as the adapter would, through `spawnForSdk`.
     */
    const pids = sessionPids();
    const cmdShim = options.pathToClaudeCodeExecutable !== undefined && /\.(cmd|bat)$/i.test(options.pathToClaudeCodeExecutable);
    const spawn = options.spawn ?? (cmdShim ? undefined : spawnForSdk);

    const configDirOf = (env: LocalEnvironment) => env.profileDir ?? joinPath(home(), '.claude');

    /** Removes what could select another account; sets this environment's config dir (or none: the default). */
    const childEnvFor = (env: LocalEnvironment) => accountEnv(env, options.parentEnv ?? process.env);

    const agentFor = (env: LocalEnvironment) => {
        assertRuntime(env);
        let agent = agents.get(env.id);
        if (!agent) {
            agent = claudeCode({
                id: `${RUNTIME}:${env.id}`,
                settingSources: SETTING_SOURCES,
                env: childEnvFor(env),
                ...(options.models ? { models: options.models } : {}),
                ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
                // Only where the machine allows it (#453): without it the adapter refuses `bypassPermissions` on open and configure.
                ...(env.allowBypassPermissions ? { allowDangerouslySkipPermissions: true } : {}),
                query: withoutCrossSessionTools(options.query ?? sdkQuery),
                ...(options.listen ? { listen: options.listen } : {}),
                ...(options.listSessions ? { listSessions: options.listSessions } : {}),
                ...(spawn ? { spawn: pids.spawning(spawn) } : {}),
                ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {})
            });
            agents.set(env.id, agent);
        }
        return agent;
    };

    const inspect = async (env: LocalEnvironment): Promise<EnvironmentInspection> => {
        assertRuntime(env);
        const configDir = configDirOf(env);
        const accountFile = env.profileDir === undefined ? joinPath(home(), '.claude.json') : joinPath(configDir, '.claude.json');
        const auth = await readProfileAuth(configDir, accountFile, authDeps);
        return {
            ...auth,
            isolation: env.profileDir === undefined ? 'none' : 'config-dir',
            capabilities: claudeCodeCapabilityReport(agentFor(env).capabilities)
        };
    };

    return {
        runtime: RUNTIME,
        agentFor,
        configDirOf,
        inspect,
        // The adapter's capabilities do not depend on the environment (#541).
        report: () => claudeCodeCapabilityReport(CLAUDE_CODE_CAPABILITIES),

        async open(env: LocalEnvironment, spec: OpenSpec, ctx: RuntimeOpenContext<Policy>): Promise<OpenedRuntimeSession<AgentSession>> {
            const agent = agentFor(env);
            assertCwdInRoots(RUNTIME, env, spec.cwd);
            if (spec.permissionMode === BYPASS_PERMISSIONS_MODE && !env.allowBypassPermissions) {
                throw new Error(`${RUNTIME}: permission mode ${BYPASS_PERMISSIONS_MODE} is not allowed in environment ${env.id} (set allowBypassPermissions on it in environments.json)`);
            }
            const { tools: platform, unknown } = bridgedPlatformTools(spec.tools, ctx.callTool);
            const connectors = await openDaemonConnectors({
                connectors: spec.connectors ?? [],
                env,
                cwd: spec.cwd,
                callTool: ctx.callTool,
                ...(options.connectors ? { opener: options.connectors } : {}),
                taken: platform.map((t) => t.name)
            });
            const tools = [...platform, ...connectors.tools];
            // Plan mode's way out always reaches a person (#454), whatever the rules and grants say.
            const policy = withPlanReview(withConnectorPolicy(ctx.policy, connectors.annotations));
            let session: AgentSession;
            try {
                session = await agent.session({
                    cwd: spec.cwd,
                    system: withUnavailableConnectors(claudeCodeSystemPrompt(spec.system), connectors.unavailable),
                    systemPromptPreset: true,
                    settingSources: SETTING_SOURCES,
                    interactive: true,
                    tools,
                    ...(spec.model !== undefined ? { model: spec.model } : {}),
                    ...(spec.permissionMode !== undefined ? { permissionMode: spec.permissionMode as PermissionMode } : {}),
                    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
                    ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
                    ...(policy !== undefined ? { policy } : {}),
                    ...(spec.resume !== undefined ? { resume: spec.resume as SessionRef } : {})
                });
            } catch (e) {
                await connectors.close();
                throw e;
            }
            // A connector tool the agent is granted is not a platform tool the daemon failed to serve: `__` names are connectors'.
            const capabilities = claudeCodeCapabilityReport(agent.capabilities, {
                tools: tools.map((t) => t.name),
                unknownTools: unknown.filter((name) => !name.includes('__')),
                unavailableConnectors: connectors.unavailable
            });
            // The CLI's own title for the conversation (#460), read from the transcript it files under this environment's config
            // dir. The ref carries the CLI's id once the first stream event names it (#389); before that there is nothing to read.
            const title = async (): Promise<string | undefined> => {
                const ref = session.ref as { readonly id?: unknown; readonly data?: { readonly cwd?: unknown } };
                if (typeof ref.id !== 'string' || !ref.id) return undefined;
                const cwd = typeof ref.data?.cwd === 'string' && ref.data.cwd ? ref.data.cwd : spec.cwd;
                return readSessionTitle({ configDir: configDirOf(env), cwd, sessionId: ref.id });
            };
            const tracked = pids.track(ctx.sessionId, session);
            return { session: closingWith(tracked.session, connectors.close), capabilities, title, pid: tracked.pid };
        },

        models(env: LocalEnvironment): Promise<readonly ModelOption[] | null> {
            assertRuntime(env);
            return claudeCodeModels(env, {
                parentEnv: options.parentEnv ?? process.env,
                ...(options.modelsQuery ? { query: options.modelsQuery } : {}),
                ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {})
            });
        },

        async doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport> {
            const mine = envs.filter((e) => e.runtime === RUNTIME);
            // One unreadable profile is that environment's finding, not a failed check for all of them — and
            // the error's message names the path, which never leaves the machine (#274): only its code goes.
            const inputs = await Promise.all(
                mine.map(async (env): Promise<DoctorInput> => {
                    const configDir = configDirOf(env);
                    try {
                        return { env, configDir, inspection: await inspect(env) };
                    } catch (e) {
                        const code = (e as { code?: unknown }).code;
                        const inspection: EnvironmentInspection = {
                            authStatus: 'unknown',
                            isolation: env.profileDir === undefined ? 'none' : 'config-dir',
                            capabilities: claudeCodeCapabilityReport(agentFor(env).capabilities)
                        };
                        return { env, configDir, inspection, unreadable: typeof code === 'string' ? code : 'unreadable' };
                    }
                })
            );
            return claudeCodeDoctor(inputs);
        },

        async dispose() {
            const all = [...agents.values()];
            agents.clear();
            await Promise.all(all.map((a) => a.dispose()));
        }
    };
}
