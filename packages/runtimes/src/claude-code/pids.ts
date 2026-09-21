/**
 * Which CLI process is which session's (#400). The adapter starts one `claude` process per session, lazily,
 * inside the session's `prompt()` — through the agent-level `spawn` it was given, which knows nothing of
 * sessions. So the driver runs each session's `prompt` in its own async context and reads that context when
 * the spawn happens: the process started there is that session's. A spawn outside any prompt (there is none
 * today) stays unattributed — the session then reads unknown, never another session's number.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '@sigx/ai-agent';

export type SpawnFn = (options: SpawnOptions) => SpawnedProcess;

export interface SessionPids {
    /** `inner` with every process it starts charged to the session whose prompt is running. */
    spawning(inner: SpawnFn): SpawnFn;
    /** `session` with its prompts run in the session's context, and `pid()` reading the CLI process started in it. */
    track(sessionId: string, session: AgentSession): { readonly session: AgentSession; readonly pid: () => number | undefined };
}

export function sessionPids(): SessionPids {
    const prompting = new AsyncLocalStorage<string>();
    const pids = new Map<string, number>();
    return {
        spawning: (inner) => (options) => {
            const proc = inner(options);
            const sessionId = prompting.getStore();
            const pid = (proc as { readonly pid?: unknown }).pid;
            if (sessionId !== undefined && typeof pid === 'number') {
                pids.set(sessionId, pid);
                // A restart (the adapter re-spawns when the session's options change) has replaced it by the time the old one exits.
                proc.on('exit', () => {
                    if (pids.get(sessionId) === pid) pids.delete(sessionId);
                });
            }
            return proc;
        },
        track: (sessionId, session) => {
            const tracked = Object.create(session, {
                prompt: { value: (...args: Parameters<AgentSession['prompt']>) => prompting.run(sessionId, () => session.prompt(...args)) },
                close: {
                    value: async () => {
                        try {
                            await session.close();
                        } finally {
                            pids.delete(sessionId);
                        }
                    }
                }
            }) as AgentSession;
            return { session: tracked, pid: () => pids.get(sessionId) };
        }
    };
}
