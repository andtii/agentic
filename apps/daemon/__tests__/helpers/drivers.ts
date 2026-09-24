/** Test drivers over the core `RuntimeDriver` seam. */

import type { AuthStatus, CapabilityReport, LocalEnvironment, OpenSpec, RuntimeOpenContext } from '@agentic/core';
import type { ConformanceScript } from '@agentic/daemon-protocol/testing';
import { createEventLog, createSessionCore, type Agent, type AgentEvent, type AgentSession, type AgentTurn, type Policy, type SessionRef, type TurnResult } from '@sigx/ai-agent';
import type { DaemonDriver } from '../../src/daemon';

export const SCRIPTED_REPORT: CapabilityReport = {
    runtime: 'scripted',
    supported: ['prompt', 'cancel', 'close'],
    unsupported: [{ op: 'fork', reason: 'scripted' }],
    resume: 'local',
    cancel: true,
    steer: false,
    permissions: 'none',
    tools: 'mcp'
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * A session that plays `script`: per prompt, the scripted tool call through
 * `ctx.callTool`, then exactly `script.events` events ending in `turn-end`.
 * The replay buffer is small on purpose, so a reconnect has to read the
 * daemon's log on disk. Resumed from `resume`, it stamps the epoch after the
 * ref's (#363) and names it in its own ref's `data.epoch`, like every driver.
 */
export function scriptedSession(ctx: RuntimeOpenContext, script: ConformanceScript, bufferSize = 16, resume?: SessionRef): AgentSession {
    // Epoch 0 like the reference fake: the suite expects the first event's epoch to equal `session.opened.head`'s, which is (0, 0) before any event.
    const previous = (resume?.data as { epoch?: number } | undefined)?.epoch ?? 0;
    const log = createEventLog({ sessionId: ctx.sessionId, bufferSize, epoch: resume ? previous + 1 : 0 });
    let busy = false;
    let turns = 0;
    const events = (turnId: string): AsyncIterable<AgentEvent> => ({
        async *[Symbol.asyncIterator]() {
            for await (const e of log.subscribe()) {
                if (e.turnId !== turnId) continue;
                yield e;
                if (e.type === 'turn-end') return;
            }
        }
    });
    return {
        id: ctx.sessionId,
        ref: { agent: 'scripted', v: 1, id: ctx.sessionId, ...(resume ? { data: { epoch: log.epoch } } : {}) },
        prompt(_input, options): AgentTurn {
            const turnId = options?.turnId ?? `turn_${++turns}`;
            if (busy) throw new Error('busy');
            busy = true;
            const result = (async (): Promise<TurnResult> => {
                await tick();
                if (script.tool) await ctx.callTool(script.tool.name, script.tool.input).catch(() => undefined);
                for (let i = 1; i < script.events; i++) {
                    log.append({ type: 'part-delta', partId: 'part_1', delta: `${i} `, turnId });
                    if (i % 10 === 0) await tick();
                }
                log.append({ type: 'turn-end', stopReason: 'end_turn', turnId });
                busy = false;
                return { turnId, stopReason: 'end_turn' };
            })();
            return { id: turnId, result, [Symbol.asyncIterator]: () => events(turnId)[Symbol.asyncIterator]() };
        },
        async respond() {},
        async cancel() {},
        subscribe: (from) => log.subscribe(from),
        async close() {
            log.close();
        }
    };
}

export interface ScriptedDriver extends DaemonDriver {
    readonly auth: Map<string, AuthStatus>;
    readonly opened: { env: LocalEnvironment; spec: OpenSpec }[];
}

export function scriptedDriver(script: ConformanceScript): ScriptedDriver {
    const auth = new Map<string, AuthStatus>();
    const opened: { env: LocalEnvironment; spec: OpenSpec }[] = [];
    return {
        runtime: 'scripted',
        auth,
        opened,
        async inspect(env) {
            return { authStatus: auth.get(env.id) ?? 'ok', isolation: 'none', capabilities: SCRIPTED_REPORT };
        },
        async open(env, spec, ctx) {
            opened.push({ env, spec });
            return { session: scriptedSession(ctx, script, 16, spec.resume as SessionRef | undefined), capabilities: SCRIPTED_REPORT };
        },
        async doctor() {
            return { ok: true, findings: [] };
        }
    };
}

/**
 * `scriptedDriver` whose runtime names its session on the first prompt, the way a CLI reports its own id with the first
 * stream event (#389): `session.opened` carries the placeholder (the platform's id), `ref` reads `<id>.run` from then on.
 */
export function namingDriver(script: ConformanceScript): ScriptedDriver {
    const base = scriptedDriver(script);
    return {
        ...base,
        async open(env, spec, ctx) {
            const { session: inner, capabilities } = await base.open(env, spec, ctx);
            let named = false;
            const session: AgentSession = {
                ...inner,
                get ref() {
                    return { ...inner.ref, id: named ? `${ctx.sessionId}.run` : ctx.sessionId };
                },
                prompt(input, options) {
                    named = true;
                    return inner.prompt(input, options);
                }
            };
            return { session, capabilities };
        }
    };
}

/**
 * `namingDriver` whose runtime titles its conversation (#460): `answers[i]` is what the i-th probe of the session's
 * title finds (the last one repeats), like a CLI whose auto-title lands some time after a turn and moves on with the
 * work. `probes` counts the turns each probe was made after.
 */
export function titlingDriver(script: ConformanceScript, answers: readonly (string | undefined)[]): ScriptedDriver & { readonly probes: number[] } {
    const base = namingDriver(script);
    const probes: number[] = [];
    return {
        ...base,
        probes,
        async open(env, spec, ctx) {
            const opened = await base.open(env, spec, ctx);
            let turns = 0;
            const session: AgentSession = {
                ...opened.session,
                get ref() {
                    return opened.session.ref;
                },
                prompt(input, options) {
                    turns++;
                    return opened.session.prompt(input, options);
                }
            };
            return {
                ...opened,
                session,
                async title() {
                    const answer = answers[Math.min(probes.length, answers.length - 1)];
                    probes.push(turns);
                    return answer;
                }
            };
        }
    };
}

export const MOCK_REPORT: CapabilityReport = { ...SCRIPTED_REPORT, runtime: 'mock', supported: ['prompt', 'cancel', 'close', 'configure'], unsupported: [] };

/** Any `@sigx/ai-agent` `Agent` (e.g. `mockAgent`) as a driver: one agent per runtime, sessions opened with the spec. */
export function agentDriver(runtime: string, agent: Agent, report: CapabilityReport = { ...MOCK_REPORT, runtime }): DaemonDriver & { readonly contexts: RuntimeOpenContext<Policy>[] } {
    const contexts: RuntimeOpenContext<Policy>[] = [];
    return {
        runtime,
        contexts,
        async inspect() {
            return { authStatus: 'ok', isolation: 'config-dir', capabilities: report };
        },
        async open(_env, spec, ctx) {
            contexts.push(ctx);
            const session = await agent.session({ system: spec.system, ...(spec.model ? { model: spec.model } : {}), ...(ctx.policy ? { policy: ctx.policy } : {}), ...(spec.resume !== undefined ? { resume: spec.resume as SessionRef } : {}) });
            return { session, capabilities: report };
        },
        async doctor() {
            return { ok: true, findings: [] };
        }
    };
}

/**
 * A session that opens a turn nobody asked for, the way `@sigx/ai-agent-claude-code@0.2.1` does after `configure`
 * (#604): the CLI's answer to `setModel` starts an implicit, input-less turn that only a `result` would end, and none
 * comes. The ghost turn ends only when it is cancelled. `configureMs` delays `configure` (the control request's
 * round trip); `content` makes the implicit turn carry a part, like a background task's result (#510).
 */
export function ghostDriver(options: { readonly configureMs?: number; readonly content?: boolean } = {}): DaemonDriver & { readonly configured: string[]; readonly prompted: string[] } {
    const configured: string[] = [];
    const prompted: string[] = [];
    const report: CapabilityReport = { ...MOCK_REPORT, runtime: 'ghost' };
    return {
        runtime: 'ghost',
        configured,
        prompted,
        async inspect() {
            return { authStatus: 'ok', isolation: 'config-dir', capabilities: report };
        },
        async open(_env, _spec, ctx) {
            const core = createSessionCore({ id: ctx.sessionId, log: createEventLog({ sessionId: ctx.sessionId }) });
            const ghost = () =>
                core.startTurn([], undefined, async (driver) => {
                    if (options.content) {
                        driver.emit({ type: 'part-start', messageId: `a:${driver.turnId}`, partId: `${driver.turnId}:0`, kind: 'text' });
                        driver.emit({ type: 'part-delta', partId: `${driver.turnId}:0`, delta: 'a background task finished' });
                    }
                    await new Promise<void>((resolve) => driver.signal.addEventListener('abort', () => resolve(), { once: true }));
                    driver.end({ stopReason: 'cancelled' });
                });
            const session: AgentSession = {
                id: ctx.sessionId,
                ref: { agent: 'ghost', v: 1, id: ctx.sessionId },
                prompt(input, promptOptions) {
                    return core.startTurn(input, promptOptions, async (driver) => {
                        prompted.push(driver.turnId);
                        await tick();
                        driver.emit({ type: 'part-start', messageId: `a:${driver.turnId}`, partId: `${driver.turnId}:0`, kind: 'text' });
                        driver.emit({ type: 'part-delta', partId: `${driver.turnId}:0`, delta: 'answered' });
                        driver.emit({ type: 'part-end', partId: `${driver.turnId}:0` });
                        driver.end({ stopReason: 'end_turn' });
                    });
                },
                async configure(patch) {
                    if (options.configureMs) await new Promise((r) => setTimeout(r, options.configureMs));
                    configured.push(String(patch.model));
                    core.emit({ type: 'config', options: [] });
                    ghost();
                },
                respond: (requestId, decision) => core.respond(requestId, decision),
                cancel: (target) => core.cancel(target),
                subscribe: (from) => core.subscribe(from),
                close: () => core.close()
            };
            return { session, capabilities: report };
        },
        async doctor() {
            return { ok: true, findings: [] };
        }
    };
}
