/**
 * Single-record lookups do not materialise the log (#391): answering a request
 * card, a `respond`, a `resolution` and the decision's own bookkeeping go through
 * `requestById` / `findEvent`, never `knownEvents` — which `get()` still calls
 * for the one thing that genuinely needs the whole set, the session's grants.
 */
import { actorKey, type AgentId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { defineSessionActor, SessionPage, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
import { knownEvents } from '../src/session/state';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

vi.mock('../src/session/state', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/session/state')>();
    return { ...original, knownEvents: vi.fn(original.knownEvents) };
});

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const KEY = actorKey(WS, 'session', 'session_1');
const config: FrozenAgentConfig = {
    agentId: AGENT,
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'assistant',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'off' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};
const spec: SessionOpenSpec = { agentId: AGENT, runtime: 'anthropic-api', taskId: 'task_1' as TaskId, config };

function askingAgent(): MockAgent {
    return mockAgent({ respond: () => [{ request: { kind: 'input', message: 'Which colour?' } }, { text: 'ok' }] });
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;

beforeEach(() => {
    Session = defineSessionActor({ factory: localFactory(askingAgent()) });
    app = testActorApp([Session, SessionPage]);
    return app.start();
});
afterEach(() => app.stop());

const session = () => app.as(owner).actor(Session, KEY);

describe('request lookups without the whole log (#391)', { timeout: 30_000 }, () => {
    it('request(id), respond, resolution and the decision itself never call knownEvents; get() does, for the grants', async () => {
        await session().open(spec);
        await session().prompt('ask', 't1');
        await until(async () => (await session().get()).openRequests.length === 1, 'the request');
        const requestId = (await session().get()).openRequests[0]!;
        vi.mocked(knownEvents).mockClear();

        expect(await session().request(requestId)).toMatchObject({ request: { requestId, kind: 'input', message: 'Which colour?' } });
        const decided = (async () => {
            for await (const ev of session().resolution(requestId)) return ev;
            return undefined;
        })();
        expect(await session().respond(requestId, { type: 'input', answers: 'blue' })).toMatchObject({ kind: 'ack' });
        expect(await decided).toMatchObject({ type: 'request-resolved', requestId, outcome: 'input', answers: 'blue' });
        expect(await session().request(requestId)).toMatchObject({ resolved: { outcome: 'input', answers: 'blue' } });
        expect(knownEvents).not.toHaveBeenCalled();

        await session().get();
        expect(knownEvents).toHaveBeenCalledTimes(1);
    });
});
