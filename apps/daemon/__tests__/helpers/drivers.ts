/** Test drivers over the core `RuntimeDriver` seam. */

import type { AuthStatus, CapabilityReport, LocalEnvironment, OpenSpec, RuntimeOpenContext } from '@agentic/core';
import type { ConformanceScript } from '@agentic/daemon-protocol/testing';
import { createEventLog, type Agent, type AgentEvent, type AgentSession, type AgentTurn, type Policy, type TurnResult } from '@sigx/ai-agent';
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
 * daemon's log on disk.
 */
export function scriptedSession(ctx: RuntimeOpenContext, script: ConformanceScript, bufferSize = 16): AgentSession {
    // Epoch 0 like the reference fake: the suite expects the first event's epoch to equal `session.opened.head`'s, which is (0, 0) before any event.
    const log = createEventLog({ sessionId: ctx.sessionId, bufferSize, epoch: 0 });
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
        ref: { agent: 'scripted', v: 1, id: ctx.sessionId },
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
            return { session: scriptedSession(ctx, script), capabilities: SCRIPTED_REPORT };
        },
        async doctor() {
            return { ok: true, findings: [] };
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
            const session = await agent.session({ system: spec.system, ...(spec.model ? { model: spec.model } : {}), ...(ctx.policy ? { policy: ctx.policy } : {}) });
            return { session, capabilities: report };
        },
        async doctor() {
            return { ok: true, findings: [] };
        }
    };
}
