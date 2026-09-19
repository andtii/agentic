/** Session plumbing every daemon driver shares: where a session may run, and closing what it opened with it. */

import type { AgentSession } from '@sigx/ai-agent';
import { isWithin } from '@sigx/ai-agent/coding';
import type { LocalEnvironment } from '@agentic/core';

/** Throws unless `cwd` lies inside one of `env.cwdRoots` (EXE-08). `runtime` prefixes the message. */
export function assertCwdInRoots(runtime: string, env: LocalEnvironment, cwd: string): void {
    if (!env.cwdRoots.some((root) => isWithin(cwd, root))) {
        throw new Error(`[${runtime}] cwd ${cwd} is outside the cwdRoots of environment "${env.name}"`);
    }
}

/** Throws unless `env` runs `runtime` — a driver never opens another runtime's environment. */
export function assertRuntime(runtime: string, env: LocalEnvironment): void {
    if (env.runtime !== runtime) throw new Error(`[${runtime}] environment "${env.name}" runs "${env.runtime}", not ${runtime}`);
}

/** `session`, whose `close` also runs `after` (its connectors, its tool server) — every other member read through to the adapter's session. */
export function closingWith(session: AgentSession, after: () => Promise<void>): AgentSession {
    return Object.create(session, {
        close: {
            value: async () => {
                try {
                    await session.close();
                } finally {
                    await after();
                }
            }
        }
    }) as AgentSession;
}
