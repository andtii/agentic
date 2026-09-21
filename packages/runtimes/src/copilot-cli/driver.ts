/**
 * `copilotCliDriver` — the `RuntimeDriver` for daemon-hosted GitHub Copilot CLI (#319, architecture §5b).
 *
 * One Copilot runtime (`CopilotClient`) per environment, isolated by its own `COPILOT_HOME`, with the
 * parent's token variables removed (`env.ts`; EXE-04/05). Sessions append the
 * platform's system prompt to Copilot's own, let Copilot read the repository's instructions (#461; platform
 * memory stays labelled as the platform's, MEM-10), run the
 * platform tools the spec names and the agent's MCP connectors as client tools bridged back through
 * `callTool` (shared with Claude Code: `../harness`), and report their capabilities (AGT-09).
 */

import { homedir } from 'node:os';
import type { AgentSession, Policy, SessionRef } from '@sigx/ai-agent';
import { buildChildEnv } from '@sigx/ai-agent-node';
import type { DoctorReport, EnvironmentInspection, LocalEnvironment, OpenedRuntimeSession, OpenSpec, RuntimeDriver, RuntimeOpenContext } from '@agentic/core';
import { harnessCapabilityReport, type HarnessReportInput } from '../harness/capabilities.js';
import { openDaemonConnectors, withConnectorPolicy, type DaemonConnectorOpener } from '../harness/connectors.js';
import { assertCwdInRoots, assertRuntime, closingWith } from '../harness/session.js';
import { withPlatformMemoryLabel, withUnavailableConnectors } from '../harness/system.js';
import { bridgedPlatformTools } from '../harness/tools.js';
import { COPILOT_CLI_CAPABILITIES, copilotCli, type CopilotSessionOptions } from './agent.js';
import { readCopilotAuth } from './auth.js';
import { copilotCliDoctor, type CopilotDoctorInput } from './doctor.js';
import { copilotAccountEnv } from './env.js';
import { loadCopilotClient, type CopilotClientLike, type CreateCopilotClient } from './sdk.js';
import type { Agent } from '@sigx/ai-agent';

const RUNTIME = 'copilot-cli';

export const COPILOT_PLATFORM_MEMORY_NOTE =
    'Supplied by the agentic platform for this session. It is not Copilot memory: the repository instructions of the folder (.github/copilot-instructions.md, AGENTS.md) are loaded as usual and belong to the project, not to this agent. Store what should outlive the session with memory_remember, not in files.';

export interface CopilotCliDriverOptions {
    /** Builds a client for one profile; the SDK's `CopilotClient` by default. */
    readonly createClient?: CreateCopilotClient;
    /** The daemon's own environment, whose account variables are kept out of every runtime. Default `process.env`. */
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    /** Where Copilot keeps its data without `COPILOT_HOME`. Default the user's home. */
    readonly home?: string;
    /** Opens an MCP connector as tools — `@agentic/mcp`'s openers, wired by the daemon. Absent: connectors are left out, and the agent is told why. */
    readonly connectors?: DaemonConnectorOpener;
    /** How long an aborted turn waits for Copilot to go idle. */
    readonly abortGraceMs?: number;
}

export interface CopilotCliDriver extends RuntimeDriver<AgentSession, Policy> {
    /** The agent every session of `env` runs on — the same instance `open` uses. */
    agentFor(env: LocalEnvironment): Agent<CopilotSessionOptions>;
    /** `env`'s runtime, started — shared by its sessions and the usage probe. */
    clientFor(env: LocalEnvironment): Promise<CopilotClientLike>;
    /** The `COPILOT_HOME` the runtime uses for `env`. */
    homeOf(env: LocalEnvironment): string;
    /** Dispose every agent and stop every runtime. */
    dispose(): Promise<void>;
}

const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`;

export function copilotCliDriver(options: CopilotCliDriverOptions = {}): CopilotCliDriver {
    const createClient = options.createClient ?? loadCopilotClient;
    const clients = new Map<string, Promise<CopilotClientLike>>();
    const agents = new Map<string, Agent<CopilotSessionOptions>>();
    const home = () => options.home ?? homedir();

    const homeOf = (env: LocalEnvironment) => env.profileDir ?? joinPath(home(), '.copilot');

    const clientFor = (env: LocalEnvironment): Promise<CopilotClientLike> => {
        assertRuntime(RUNTIME, env);
        let client = clients.get(env.id);
        if (!client) {
            const parent = options.parentEnv ?? process.env;
            const childEnv = buildChildEnv({ base: parent as NodeJS.ProcessEnv, extra: copilotAccountEnv(env, parent) });
            client = (async () => {
                const c = await createClient({ ...(env.profileDir !== undefined ? { baseDirectory: env.profileDir } : {}), env: childEnv });
                await c.start();
                return c;
            })();
            // A runtime that failed to start is tried again next time, not remembered as broken.
            client.catch(() => clients.delete(env.id));
            clients.set(env.id, client);
        }
        return client;
    };

    const agentFor = (env: LocalEnvironment) => {
        assertRuntime(RUNTIME, env);
        let agent = agents.get(env.id);
        if (!agent) {
            agent = copilotCli({ id: `${RUNTIME}:${env.id}`, client: () => clientFor(env), ...(options.abortGraceMs !== undefined ? { abortGraceMs: options.abortGraceMs } : {}) });
            agents.set(env.id, agent);
        }
        return agent;
    };

    const report = (input?: HarnessReportInput) =>
        harnessCapabilityReport(
            {
                runtime: RUNTIME,
                name: 'Copilot CLI',
                runtimeMemory: 'repository instructions and Copilot config are loaded from the folder and belong to the project; memory comes from the platform, labelled in the system prompt'
            },
            COPILOT_CLI_CAPABILITIES,
            input
        );

    const isolation = (env: LocalEnvironment): EnvironmentInspection['isolation'] => (env.profileDir === undefined ? 'none' : 'config-dir');

    const inspectWithAuthType = async (env: LocalEnvironment): Promise<{ readonly inspection: EnvironmentInspection; readonly authType?: string }> => {
        assertRuntime(RUNTIME, env);
        const { authType, ...auth } = await readCopilotAuth(await clientFor(env));
        return { inspection: { ...auth, isolation: isolation(env), capabilities: report() }, ...(authType !== undefined ? { authType } : {}) };
    };
    const inspect = async (env: LocalEnvironment): Promise<EnvironmentInspection> => (await inspectWithAuthType(env)).inspection;

    return {
        runtime: RUNTIME,
        agentFor,
        clientFor,
        homeOf,
        inspect,

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
                    system: withUnavailableConnectors(withPlatformMemoryLabel(spec.system, COPILOT_PLATFORM_MEMORY_NOTE), connectors.unavailable),
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
            // A connector tool the agent is granted is not a platform tool the daemon failed to serve: `__` names are connectors'.
            const capabilities = report({ tools: tools.map((t) => t.name), unknownTools: unknown.filter((name) => !name.includes('__')), unavailableConnectors: connectors.unavailable });
            return { session: closingWith(session, connectors.close), capabilities };
        },

        async doctor(envs: readonly LocalEnvironment[]): Promise<DoctorReport> {
            const mine = envs.filter((e) => e.runtime === RUNTIME);
            // A runtime that will not start is that environment's finding; its message may name a path, so only a short cause goes (#274).
            const inputs = await Promise.all(
                mine.map(async (env): Promise<CopilotDoctorInput> => {
                    try {
                        return { env, home: homeOf(env), ...(await inspectWithAuthType(env)) };
                    } catch (e) {
                        const code = (e as { code?: unknown }).code;
                        return {
                            env,
                            home: homeOf(env),
                            inspection: { authStatus: 'unknown', isolation: isolation(env), capabilities: report() },
                            unavailable: typeof code === 'string' ? code : e instanceof Error ? e.name : 'error'
                        };
                    }
                })
            );
            return copilotCliDoctor(inputs);
        },

        async dispose() {
            const all = [...agents.values()];
            agents.clear();
            await Promise.all(all.map((a) => a.dispose()));
            const started = [...clients.values()];
            clients.clear();
            await Promise.all(started.map((c) => c.then((client) => client.stop()).catch(() => undefined)));
        }
    };
}
