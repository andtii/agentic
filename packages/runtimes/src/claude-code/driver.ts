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
 * `callTool`, and report their capabilities (AGT-09).
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { SpawnOptions, SpawnedProcess, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentSession, ConfigValue, Policy, SessionRef } from '@sigx/ai-agent';
import { isWithin } from '@sigx/ai-agent/coding';
import { claudeCode, type ClaudeCodeSessionOptions, type ListenFn, type ListSessionsFn, type QueryFn } from '@sigx/ai-agent-claude-code';
import type { DoctorReport, EnvironmentInspection, LocalEnvironment, OpenedRuntimeSession, OpenSpec, RuntimeDriver, RuntimeOpenContext } from '@agentic/core';
import { readProfileAuth, type ProfileAuthDeps } from './auth.js';
import { claudeCodeCapabilityReport } from './capabilities.js';
import { claudeCodeDoctor } from './doctor.js';
import { claudeCodeSystemPrompt } from './system.js';
import { bridgedPlatformTools } from './tools.js';

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

    const assertRuntime = (env: LocalEnvironment) => {
        if (env.runtime !== RUNTIME) throw new Error(`[claude-code] environment "${env.name}" runs "${env.runtime}", not ${RUNTIME}`);
    };

    const configDirOf = (env: LocalEnvironment) => env.profileDir ?? joinPath(home(), '.claude');

    /** Removes what could select another account; sets this environment's config dir (or none: the default). */
    const childEnvFor = (env: LocalEnvironment): Record<string, string | undefined> => {
        const parent = options.parentEnv ?? process.env;
        const extra: Record<string, string | undefined> = {};
        for (const key of Object.keys(parent)) if (/^ANTHROPIC_/i.test(key) || /^CLAUDE_CONFIG_DIR$/i.test(key)) extra[key] = undefined;
        extra.CLAUDE_CONFIG_DIR = env.profileDir;
        return extra;
    };

    const agentFor = (env: LocalEnvironment) => {
        assertRuntime(env);
        let agent = agents.get(env.id);
        if (!agent) {
            agent = claudeCode({
                id: `${RUNTIME}:${env.id}`,
                settingSources: [],
                env: childEnvFor(env),
                ...(options.models ? { models: options.models } : {}),
                ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
                ...(options.query ? { query: options.query } : {}),
                ...(options.listen ? { listen: options.listen } : {}),
                ...(options.listSessions ? { listSessions: options.listSessions } : {}),
                ...(options.spawn ? { spawn: options.spawn } : {}),
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

        async open(env: LocalEnvironment, spec: OpenSpec, ctx: RuntimeOpenContext<Policy>): Promise<OpenedRuntimeSession<AgentSession>> {
            const agent = agentFor(env);
            if (!env.cwdRoots.some((root) => isWithin(spec.cwd, root))) {
                throw new Error(`[claude-code] cwd ${spec.cwd} is outside the cwdRoots of environment "${env.name}"`);
            }
            const { tools, unknown } = bridgedPlatformTools(spec.tools, ctx.callTool);
            const session = await agent.session({
                cwd: spec.cwd,
                system: claudeCodeSystemPrompt(spec.system),
                systemPromptPreset: true,
                settingSources: [],
                interactive: true,
                tools,
                ...(spec.model !== undefined ? { model: spec.model } : {}),
                ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
                ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
                ...(ctx.policy !== undefined ? { policy: ctx.policy } : {}),
                ...(spec.resume !== undefined ? { resume: spec.resume as SessionRef } : {})
            });
            return { session, capabilities: claudeCodeCapabilityReport(agent.capabilities, { tools: tools.map((t) => t.name), unknownTools: unknown }) };
        },

        async doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport> {
            const mine = envs.filter((e) => e.runtime === RUNTIME);
            const inputs = await Promise.all(mine.map(async (env) => ({ env, configDir: configDirOf(env), inspection: await inspect(env) })));
            return claudeCodeDoctor(inputs);
        },

        async dispose() {
            const all = [...agents.values()];
            agents.clear();
            await Promise.all(all.map((a) => a.dispose()));
        }
    };
}
