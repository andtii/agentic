/**
 * `codexCliDriver` — the `RuntimeDriver` for daemon-hosted Codex (#320, architecture §5b).
 *
 * One `codexCli()` agent per environment, over one `codex app-server` spawned with the
 * profile's own `CODEX_HOME` and none of the daemon's `OPENAI_*` variables (EXE-04/05).
 * Sessions get the platform's system prompt as developer instructions (memory labelled as the
 * platform's, MEM-10), the platform tools the spec names and the agent's MCP connectors as
 * client tools on a per-session loopback MCP server (`../harness`), and report their
 * capabilities (AGT-09). Auth and usage limits come from Codex itself (`account/read`,
 * `account/rateLimits/read`) over a short-lived app-server, so no token file is read.
 */

import { homedir } from 'node:os';
import type { Agent, AgentSession, Policy, SessionRef } from '@sigx/ai-agent';
import { ExecutableNotFoundError } from '@sigx/ai-agent-node';
import type { DoctorReport, EnvironmentInspection, LocalEnvironment, OpenedRuntimeSession, OpenSpec, RuntimeDriver, RuntimeOpenContext } from '@agentic/core';
import { harnessCapabilityReport, type HarnessReportInput } from '../harness/capabilities.js';
import { openDaemonConnectors, withConnectorPolicy, type DaemonConnectorOpener } from '../harness/connectors.js';
import { assertCwdInRoots, assertRuntime as assertRuntimeOf, closingWith } from '../harness/session.js';
import { withPlatformMemoryLabel, withUnavailableConnectors } from '../harness/system.js';
import { bridgedPlatformTools } from '../harness/tools.js';
import { CODEX_CLI_PLUGIN_ID } from '../plugins.js';
import { codexCli, type CodexSessionOptions, type ServeTools } from './agent.js';
import { readCodexAuth } from './auth.js';
import { spawnCodexAppServer, type CodexConnect, type CodexConnection, type SpawnCodexOptions } from './client.js';
import { codexCliDoctor, type CodexDoctorInput } from './doctor.js';
import type { AskForApproval, SandboxMode } from './protocol.js';

const RUNTIME = CODEX_CLI_PLUGIN_ID;

export const CODEX_PLATFORM_MEMORY_NOTE =
    'Supplied by the agentic platform for this session. It is not Codex memory: AGENTS.md files and Codex memories are not what this agent remembers. Store what should outlive the session with memory_remember, not in files.';

const RUNTIME_MEMORY_REASON = 'memory comes from the platform, labelled in the developer instructions; AGENTS.md files and Codex memories are not platform memory';

/** `system` as Codex gets it: the platform's memory labelled as not Codex's (MEM-10). */
export function codexSystemPrompt(system: string): string {
    return withPlatformMemoryLabel(system, CODEX_PLATFORM_MEMORY_NOTE);
}

export function codexCliCapabilityReport(agent: Agent, input: HarnessReportInput = {}) {
    return harnessCapabilityReport({ runtime: RUNTIME, name: 'Codex', runtimeMemory: RUNTIME_MEMORY_REASON }, agent.capabilities, input);
}

export interface CodexCliDriverOptions extends Pick<SpawnCodexOptions, 'codexPath' | 'parentEnv'> {
    /** Opens an initialized app-server for an environment; `spawnCodexAppServer` by default (a fake in tests). */
    readonly connect?: CodexConnect;
    /** How session tools are served to Codex; loopback MCP by default. */
    readonly serveTools?: ServeTools;
    readonly approvalPolicy?: AskForApproval;
    readonly sandbox?: SandboxMode;
    /** Where Codex keeps its home without `CODEX_HOME`. Default the user's home. */
    readonly home?: string;
    /** Opens an MCP connector as tools (#280) — `@agentic/mcp`'s openers, wired by the daemon. */
    readonly connectors?: DaemonConnectorOpener;
    /** How long an inspection is reused (the daemon inspects, then runs doctor). Default 10 s. */
    readonly inspectTtlMs?: number;
}

export interface CodexCliDriver extends RuntimeDriver<AgentSession, Policy> {
    /** The agent every session of `env` runs on — the same instance `open` uses. */
    agentFor(env: LocalEnvironment): Agent<CodexSessionOptions>;
    /** The `CODEX_HOME` Codex uses for `env`. */
    homeOf(env: LocalEnvironment): string;
    /** Opens a short-lived, initialized app-server for `env` (inspection, the quota probe). */
    readonly connect: CodexConnect;
    /** Dispose every agent and terminate every app-server. */
    dispose(): Promise<void>;
}

const joinPath = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`;

export function codexCliDriver(options: CodexCliDriverOptions = {}): CodexCliDriver {
    const agents = new Map<string, Agent<CodexSessionOptions>>();
    const inspections = new Map<string, { at: number; value: Promise<EnvironmentInspection> }>();
    const ttl = options.inspectTtlMs ?? 10_000;
    const connect: CodexConnect =
        options.connect ??
        ((env) => spawnCodexAppServer(env, { ...(options.codexPath !== undefined ? { codexPath: options.codexPath } : {}), ...(options.parentEnv ? { parentEnv: options.parentEnv } : {}) }));

    const assertRuntime = (env: LocalEnvironment) => assertRuntimeOf(RUNTIME, env);
    const homeOf = (env: LocalEnvironment) => env.profileDir ?? joinPath(options.home ?? homedir(), '.codex');

    /** The app-server each environment's agent runs on (#400) — one process per environment, its sessions are threads in it. */
    const serverPids = new Map<string, number>();
    const agentConnect = async (env: LocalEnvironment): Promise<CodexConnection> => {
        const connection = await connect(env);
        if (connection.pid === undefined) return connection;
        const pid = connection.pid;
        serverPids.set(env.id, pid);
        // The app-server may go on its own (a crash): its pid is forgotten with the peer, not only on our close.
        void connection.peer.closed.then(() => {
            if (serverPids.get(env.id) === pid) serverPids.delete(env.id);
        });
        return {
            ...connection,
            close: async () => {
                if (serverPids.get(env.id) === pid) serverPids.delete(env.id);
                await connection.close();
            }
        };
    };

    const agentFor = (env: LocalEnvironment) => {
        assertRuntime(env);
        let agent = agents.get(env.id);
        if (!agent) {
            agent = codexCli({
                id: `${RUNTIME}:${env.id}`,
                connect: () => agentConnect(env),
                ...(options.serveTools ? { serveTools: options.serveTools } : {}),
                ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
                ...(options.sandbox ? { sandbox: options.sandbox } : {})
            });
            agents.set(env.id, agent);
        }
        return agent;
    };

    const inspectNow = async (env: LocalEnvironment): Promise<EnvironmentInspection> => {
        const connection = await connect(env);
        try {
            const auth = await readCodexAuth(connection.peer);
            return {
                authStatus: auth.authStatus,
                ...(auth.identity !== undefined ? { identity: auth.identity } : {}),
                isolation: env.profileDir === undefined ? 'none' : 'config-dir',
                capabilities: codexCliCapabilityReport(agentFor(env))
            };
        } finally {
            await connection.close().catch(() => undefined);
        }
    };

    const inspect = (env: LocalEnvironment): Promise<EnvironmentInspection> => {
        assertRuntime(env);
        const cached = inspections.get(env.id);
        if (cached && Date.now() - cached.at < ttl) return cached.value;
        const value = inspectNow(env);
        inspections.set(env.id, { at: Date.now(), value });
        value.catch(() => inspections.delete(env.id));
        return value;
    };

    return {
        runtime: RUNTIME,
        agentFor,
        homeOf,
        connect,
        inspect,
        pids: (environmentId) => {
            const pid = serverPids.get(environmentId);
            return pid === undefined ? [] : [pid];
        },

        async open(env: LocalEnvironment, spec: OpenSpec, ctx: RuntimeOpenContext<Policy>): Promise<OpenedRuntimeSession<AgentSession>> {
            const agent = agentFor(env);
            assertCwdInRoots(RUNTIME, env, spec.cwd);
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
            const policy = withConnectorPolicy(ctx.policy, connectors.annotations);
            let session: AgentSession;
            try {
                session = await agent.session({
                    cwd: spec.cwd,
                    system: withUnavailableConnectors(codexSystemPrompt(spec.system), connectors.unavailable),
                    interactive: true,
                    tools,
                    ...(spec.model !== undefined ? { model: spec.model } : {}),
                    ...(policy !== undefined ? { policy } : {}),
                    ...(spec.resume !== undefined ? { resume: spec.resume as SessionRef } : {})
                });
            } catch (e) {
                await connectors.close();
                throw e;
            }
            const capabilities = codexCliCapabilityReport(agent, {
                tools: tools.map((t) => t.name),
                unknownTools: unknown.filter((name) => !name.includes('__')),
                unavailableConnectors: connectors.unavailable
            });
            return { session: closingWith(session, connectors.close), capabilities };
        },

        async doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport> {
            const mine = envs.filter((e) => e.runtime === RUNTIME);
            const inputs = await Promise.all(
                mine.map(async (env): Promise<CodexDoctorInput> => {
                    const home = homeOf(env);
                    try {
                        return { env, home, inspection: await inspect(env) };
                    } catch (e) {
                        const code = e instanceof ExecutableNotFoundError || (e as { code?: unknown }).code === 'ENOENT' ? 'cli-missing' : typeof (e as { code?: unknown }).code === 'string' ? ((e as { code: string }).code) : 'no-answer';
                        const inspection: EnvironmentInspection = { authStatus: 'unknown', isolation: env.profileDir === undefined ? 'none' : 'config-dir', capabilities: codexCliCapabilityReport(agentFor(env)) };
                        return { env, home, inspection, unavailable: code };
                    }
                })
            );
            return codexCliDoctor(inputs);
        },

        async dispose() {
            const all = [...agents.values()];
            agents.clear();
            await Promise.all(all.map((a) => a.dispose()));
        }
    };
}
