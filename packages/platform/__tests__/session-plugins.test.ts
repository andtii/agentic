/**
 * Memory and learning through the workspace's ACTIVE plugin (#242, MEM-02,
 * LRN-01, AC-13): the Registry's answer the router recorded on the spec
 * (`spec.plugins`) picks the store a session retrieves from and writes to,
 * and the learner it learns through, each over its config. Turned off →
 * nothing is retrieved, written or learned, and the stored memories stay.
 * Real Session, Memory and Agent actors; `mockAgent` as the runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type FrozenAgentConfig, type MemoryPlugin, type MemoryScope, type MessageId, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { learningPlugin, memoryCorrectionLedger } from '@agentic/learning';
import { flatMemoryPlugin, memoryDefaultPlugin } from '@agentic/memory';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor } from '../src/agent/index';
import { isolateMemoryImpl, Memory, memoryActorImpl, memoryActorKey } from '../src/memory/index';
import type { RegistryGate } from '../src/registry/index';
import { createActorToolPorts, createToolCallPort, type AgentPrincipal } from '../src/routing/index';
import { defineSessionActor, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
import { DEFAULT_RETRIEVAL_LIMIT, LEARNING_OFF, MEMORY_OFF, memoryAccess, platformLearningPorts, type LearningPorts } from '../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const T = 1_700_000_000_000;
const MEM = 'agentic.memory.default';
const FLAT = 'agentic.memory.flat';
const LRN = 'agentic.learning.default';
const OBJECTIVE = 'Write the release notes for v2.0';

const config: FrozenAgentConfig = {
    agentId: AGENT,
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'writer',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'lessons' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};

/** The Registry's answer as `Routing.run` records it: every plugin on, at its defaults, unless a test says otherwise. */
const gate = (over: Partial<RegistryGate> = {}): RegistryGate => ({
    runtime: { id: 'anthropic-api', enabled: true, config: {} },
    memory: { id: MEM, enabled: true, config: { retrievalLimit: 8 } },
    learning: { id: LRN, enabled: true, config: { repeatThreshold: 3 } },
    channels: [],
    ...over
});

const spec = (taskId: string, plugins?: RegistryGate): SessionOpenSpec => ({
    agentId: AGENT,
    runtime: 'anthropic-api',
    taskId: taskId as TaskId,
    objective: OBJECTIVE,
    context: [{ type: 'text', text: OBJECTIVE }],
    tags: ['release'],
    config,
    system: '# Ada\n\nBe brief.',
    ...(plugins ? { plugins } : {})
});

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
let flat: MemoryPlugin;
let ports: LearningPorts;

const factory: SessionFactory = async (runtime, c) => {
    if (runtime !== 'anthropic-api') return null;
    const agent = mockAgent({ respond: () => [{ text: 'notes, as asked' }] });
    const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
    return { session, agentId: agent.id, capabilities: agent.capabilities };
};

beforeEach(() => {
    flat = flatMemoryPlugin();
    const ledger = memoryCorrectionLedger();
    ports = platformLearningPorts({
        // The static wiring a spec without a gate still gets.
        plugin: () => learningPlugin({ now: () => T, ledger }),
        memoryPlugins: { [MEM]: memoryActorImpl(), [FLAT]: isolateMemoryImpl(() => flat) },
        learningPlugins: {
            [LRN]: (c) => () => learningPlugin({ now: () => T, ledger, repeatThreshold: c['repeatThreshold'] as number, contextFor: () => ({ objective: OBJECTIVE }) })
        }
    });
    Session = defineSessionActor({ factory, now: () => T, learning: ports });
    app = testActorApp([Session, Memory, AgentActor]);
    return app.start();
});
afterEach(() => app.stop());

const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const memory = (scope: MemoryScope = `agent:${AGENT}`) => app.as(owner).actor(Memory, memoryActorKey(WS, scope));
const flatStore = () => flat.open(`agent:${AGENT}`, { now: () => T, log: () => {} });

async function remember(n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
        await memory().put({ kind: 'fact', text: `release notes fact ${i}`, tags: ['release'], confidence: 'verified', provenance: { source: 'user' } });
    }
}

async function finished(id: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    for (;;) {
        const i = await session(id).get();
        if (!i.running && i.transcriptAt && i.transcriptAt.epoch === i.head.epoch && i.transcriptAt.seq === i.head.seq) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for session ${id} to finish its turn`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

async function runTurn(id: string): Promise<MessageId> {
    expect(await session(id).prompt(OBJECTIVE, 't1')).toMatchObject({ kind: 'ack' });
    await finished(id);
    return (await session(id).transcript())!.messages.at(-1)!.id as MessageId;
}

describe('the active memory and learning plugins (#242)', () => {
    it('default: the Memory actor answers retrieval and takes the task record, as before the catalogue', async () => {
        await remember(2);
        const opened = await session('s1').open(spec('task_1', gate()));
        expect(opened.spec?.memories?.map((m) => m.text).sort()).toEqual(['release notes fact 1', 'release notes fact 2']);
        expect(opened.spec?.retrieval?.skipped).toEqual([]);

        await runTurn('s1');
        expect((await session('s1').get()).learning).toMatchObject({ status: 'completed', written: 1 });
        expect(await memory().query({ kinds: ['record'], limit: 10 })).toHaveLength(1);
    });

    it('configured: the memory plugin’s retrievalLimit bounds the session’s memories, the learner’s repeatThreshold its proposals', async () => {
        await remember(3);
        const plugins = gate({ memory: { id: MEM, enabled: true, config: { retrievalLimit: 1 } }, learning: { id: LRN, enabled: true, config: { repeatThreshold: 1 } } });
        const opened = await session('s1').open(spec('task_1', plugins));
        expect(opened.spec?.memories).toHaveLength(1);

        // One repetition is enough: the first correction already proposes an instruction change for review.
        const messageId = await runTurn('s1');
        expect((await session('s1').correct(messageId, 'Never mention ticket numbers', 'never')).parked).toBe(1);
    });

    it('a retrievalLimit of 0 starts the session without memories and asks no scope', async () => {
        await remember(2);
        const opened = await session('s1').open(spec('task_1', gate({ memory: { id: MEM, enabled: true, config: { retrievalLimit: 0 } } })));
        expect(opened.spec?.memories).toEqual([]);
        expect(opened.spec?.retrieval?.skipped).toEqual([]);
    });

    it('memory turned off: nothing retrieved, written or learned — and what was stored stays', async () => {
        await remember(2);
        const off = gate({ memory: { id: MEM, enabled: false, config: {} } });
        const opened = await session('s1').open(spec('task_1', off));
        expect(opened.spec?.memories).toEqual([]);
        expect(opened.spec?.retrieval?.skipped).toEqual([{ scope: `agent:${AGENT}`, reason: expect.stringContaining(MEMORY_OFF) as string }]);
        expect(opened.spec?.retrieval?.skipped[0]!.reason).toContain(`/plugins/${MEM}`);

        const messageId = await runTurn('s1');
        // No task record, no learning record.
        expect((await session('s1').get()).learning).toBeUndefined();
        await expect(session('s1').correct(messageId, 'Never mention ticket numbers', 'never')).rejects.toThrow(LEARNING_OFF);
        const kept = await memory().query({ limit: 10 });
        expect(kept.map((r) => r.entry.kind)).toEqual(['fact', 'fact']);
    });

    it('learning turned off: memory is still retrieved; no outcome is recorded and a correction is refused', async () => {
        await remember(1);
        const opened = await session('s1').open(spec('task_1', gate({ learning: { id: LRN, enabled: false, config: {} } })));
        expect(opened.spec?.memories).toHaveLength(1);

        const messageId = await runTurn('s1');
        expect((await session('s1').get()).learning).toBeUndefined();
        expect(await memory().query({ kinds: ['record'], limit: 10 })).toEqual([]);
        await expect(session('s1').correct(messageId, 'Never mention ticket numbers', 'never')).rejects.toThrow(`${LEARNING_OFF}: the "${LRN}" learning plugin is turned off`);
    });

    it('flat active: the session remembers in the flat store, not the Memory actor (no migration — #243)', async () => {
        await remember(1);
        const opened = await session('s1').open(spec('task_1', gate({ memory: { id: FLAT, enabled: true, config: { retrievalLimit: 8 } } })));
        // The Memory actor's fact is not the flat store's: nothing moved.
        expect(opened.spec?.memories).toEqual([]);

        await runTurn('s1');
        expect((await session('s1').get()).learning).toMatchObject({ written: 1 });
        expect((await flatStore().query({ kinds: ['record'], limit: 10 })).map((r) => r.entry.kind)).toEqual(['record']);
        expect(await memory().query({ kinds: ['record'], limit: 10 })).toEqual([]);
    });

    it('flat active: a shared scope is refused (it has no access control) and listed as skipped', async () => {
        const shared = { ...spec('task_1', gate({ memory: { id: FLAT, enabled: true, config: {} } })), config: { ...config, memoryPolicy: { shared: ['team'], autoLearn: 'lessons' as const } } };
        const opened = await session('s1').open(shared);
        expect(opened.spec?.retrieval?.skipped).toEqual([{ scope: 'shared:team', reason: expect.stringContaining('needs the default memory plugin') as string }]);
    });

    it('an active plugin this build does not implement is off, and says so', async () => {
        const opened = await session('s1').open(spec('task_1', gate({ memory: { id: 'acme.memory', enabled: true, config: {} } })));
        expect(opened.spec?.retrieval?.skipped[0]!.reason).toBe(`${MEMORY_OFF}: this deployment has no implementation of the "acme.memory" memory plugin`);
    });

    it('no gate on the spec: the static wiring, as before the catalogue', async () => {
        await remember(1);
        const opened = await session('s1').open(spec('task_1'));
        expect(opened.spec?.memories).toHaveLength(1);
        await runTurn('s1');
        expect((await session('s1').get()).learning).toMatchObject({ written: 1 });
    });
});

describe('the memory tools follow the active plugin (#242)', () => {
    const principal = { kind: 'agent', workspaceId: WS, agentId: AGENT, sessionId: 's1', scopes: [] } as unknown as AgentPrincipal;
    const call = { callId: 'c1', signal: new AbortController().signal };

    it('memory turned off: memory_search and memory_remember answer why', async () => {
        const tools = createActorToolPorts({ principal, memory: memoryAccess(ports, gate({ memory: { id: MEM, enabled: false, config: {} } })) });
        await expect(tools.memory.search({ text: 'release', limit: 5 }, call)).rejects.toThrow(MEMORY_OFF);
        await expect(
            tools.memory.remember({ kind: 'fact', text: 'x', tags: [], confidence: 'verified', provenance: { source: 'agent', at: T } }, call)
        ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('flat active: memory_remember writes to the flat store', async () => {
        const tools = createActorToolPorts({ principal, memory: memoryAccess(ports, gate({ memory: { id: FLAT, enabled: true, config: {} } })) });
        await tools.memory.remember({ kind: 'fact', text: 'Ship on Tuesdays', tags: [], confidence: 'verified', provenance: { source: 'agent', at: T } }, call);
        expect((await flatStore().query({ text: 'tuesdays', limit: 5 })).map((r) => r.entry.text)).toEqual(['Ship on Tuesdays']);
        expect(await memory().query({ limit: 5 })).toEqual([]);
    });

    it('the daemon path: a tool.call reads the gate the session recorded and answers the same way', async () => {
        await session('s1').open(spec('task_1', gate({ memory: { id: MEM, enabled: false, config: {} } })));
        const port = createToolCallPort({ routing: () => Session, sessions: () => Session, memory: (g) => memoryAccess(ports, g) });
        await expect(port.call({ sessionId: 's1' as SessionId, tool: 'memory_search', input: { query: 'release' }, callId: 'c1' }, principal)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining(MEMORY_OFF) as string });
    });
});

it('the default memory plugin’s retrievalLimit default is the platform’s own budget', () => {
    const props = memoryDefaultPlugin.config.properties as Record<string, { default?: unknown }>;
    expect(props['retrievalLimit']?.default).toBe(DEFAULT_RETRIEVAL_LIMIT);
});
