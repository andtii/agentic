/**
 * An A2A peer as a runtime (#246, PLG-01, PLG-06, AC-14): the peer's manifest
 * (`a2aPeer`) is registered in the workspace Registry like any plugin, its id
 * `a2a.<id>` is resolved by prefix (`withInstanceRuntimes`) to a local runtime
 * over `a2aAgent`, and an agent put on it runs its task on the remote agent —
 * here an in-process A2A server — with the bearer token opened from the
 * Registry. Turning the plugin off refuses new work `plugin-disabled`.
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, TaskId, WorkspaceId } from '@agentic/core';
import { a2aPeer, a2aPeerRuntime, a2aPeerTokenSecret, A2A_PEER_PREFIX, createA2aHandler, memoryTaskStore, type ExposedAgent } from '@agentic/a2a';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek } from '../../src/auth/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { createSessionFactory, defineRoutingActor, routingKey, withInstanceRuntimes, type RuntimeCatalogue } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const TOKEN = 'peer-token-7d1e-SECRET';
const ORIGIN = 'https://peer.example.test';
const HELPER: ExposedAgent = { id: 'helper', name: 'Helper', description: 'A remote helper.', version: '1.0.0', promptParts: 'text' };
const CARD_URL = `${ORIGIN}/a2a/helper/.well-known/agent-card.json`;
const RUNTIME = `${A2A_PEER_PREFIX}helper`;

/** An A2A server in a `fetch`: every request's Authorization and every prompt the remote agent was given are recorded. */
function peerServer() {
    const auth: (string | null)[] = [];
    const prompts: string[] = [];
    const handler = createA2aHandler({
        port: {
            agents: () => [HELPER],
            async session() {
                const agent = mockAgent({
                    id: 'remote',
                    respond: (input) => {
                        prompts.push(typeof input === 'string' ? input : JSON.stringify(input));
                        return [{ text: 'The remote helper did it.' }];
                    }
                });
                return agent.session({ interactive: true, policy: allowAll });
            }
        },
        tasks: memoryTaskStore()
    });
    const fetch = (request: Request): Promise<Response> => {
        auth.push(request.headers.get('authorization'));
        return handler.fetch(request);
    };
    return { fetch, auth, prompts };
}

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

let app: TestActorApp;
let server: ReturnType<typeof peerServer>;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin] });

beforeEach(async () => {
    server = peerServer();
    // The app's catalogue shape (`apps/web/src/plugins/catalogue.ts`), with the peer reached through the in-process server.
    const runtimes: RuntimeCatalogue = withInstanceRuntimes({}, { [A2A_PEER_PREFIX]: (runtime) => a2aPeerRuntime(runtime, { fetch: server.fetch }) });
    Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }) });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, registry: () => Registry, runtimes });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor]);
    await app.start();
});
afterEach(() => app?.stop());

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

/** The peer, as the "Add A2A peer" dialog stores it. */
async function addPeer(options: { token?: boolean } = {}): Promise<void> {
    await registry().register(a2aPeer({ id: 'helper', name: 'Helper', cardUrl: CARD_URL }), { enabled: true, grant: 'declared' });
    if (options.token !== false) await registry().setSecret(a2aPeerTokenSecret('helper'), TOKEN);
}

async function agent(): Promise<AgentId> {
    const id = 'atlas' as AgentId;
    await app
        .as(owner)
        .actor(AgentActor, agentKey(WS, id))
        .update({ name: 'Atlas', instructions: 'Be brief.', tools: [], approvalPolicy: [], execution: { runtime: RUNTIME, offlinePolicy: 'fail' } }, 'create');
    return id;
}

async function run(id: string, assignee: AgentId): Promise<TaskView> {
    await task(id).create({ objective: 'summarise the release notes', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {} }, { owner: assignee });
    return routing().run(id as TaskId);
}

describe('an A2A peer as a runtime', () => {
    it('lists as a runtime plugin, and an agent on it runs its task on the remote agent with the bearer token from the Registry', async () => {
        await addPeer();
        const peer = (await registry().list()).find((p) => p.manifest.id === RUNTIME);
        expect(peer).toMatchObject({ enabled: true, config: {}, manifest: { kind: 'runtime', name: 'Helper' } });
        expect(peer!.grantedPermissions).toEqual(['network:peer.example.test', 'secret:a2a-helper-token']);

        const a = await agent();
        await run('t1', a);
        await settled('t1');
        const done = await task('t1').get();
        expect(done.status).toBe('completed');
        expect(server.prompts.join('\n')).toContain('summarise the release notes');
        // Every request carried the workspace's token — the card fetch and the JSON-RPC calls alike.
        expect(server.auth.length).toBeGreaterThan(1);
        expect(new Set(server.auth)).toEqual(new Set([`Bearer ${TOKEN}`]));
    });

    it('runs without a token when none is set', async () => {
        await addPeer({ token: false });
        await run('t1', await agent());
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(new Set(server.auth)).toEqual(new Set([null]));
    });

    it('turned off, new work fails plugin-disabled and the peer is never reached', async () => {
        await addPeer();
        await registry().disable(RUNTIME);
        const t = await run('t1', await agent());
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'plugin-disabled' });
        expect(t.error?.message).toContain(`/plugins/${RUNTIME}`);
        expect(server.auth).toEqual([]);
    });

    it('an id no plugin provides fails plugin-disabled, not unknown-runtime', async () => {
        const t = await run('t1', await agent());
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'plugin-disabled' });
    });
});
