/**
 * The live pages' harness (#34): the platform actors on an in-process host,
 * served over the REAL actor wire — `createFetchHandler` on the server side,
 * `fetchTransport` on the client side, joined by a fetch that never leaves
 * the process — so the pages are mounted exactly as the browser mounts
 * them: `clientDefs()` refs, `actorsPlugin` with that transport, live reads
 * on the `$live` stream. Identity rides an `x-user` header the stubbed
 * server app authenticates.
 */
import { afterEach } from 'vitest';
import { defineApp, type JSXElement } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { actorsPlugin } from '@sigx/actors/app';
import { configureActors, fetchTransport, type ActorTransport } from '@sigx/actors/client';
import { createFetchHandler } from '@sigx/actors/server';
import { stubServerApp } from '@sigx/server/testing';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent, type MockAgentOptions } from '@sigx/ai-agent/testing';
import type { AgentId, Principal, WorkspaceId } from '@agentic/core';
import { AgentActor, AuditActor, Chat, ChatPage, LedgerActor, Memory, TaskActor, Workspace, agentKey, defineInbox, defineRoutingActor, defineSessionActor, workspaceKey, type SessionFactory } from '@agentic/platform';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../../packages/platform/src/testing/index';
import { clientDefs } from '../../src/actors/client';
import { useActorDefs, useViewer } from '../../src/actors/defs';
import { setDataMode } from '../../src/data-mode';
import { createServerRouter } from '../../src/router';

export const USER = 'u_live';
export const WS = USER as WorkspaceId;
export const owner = userPrincipal(USER);
const ORIGIN = 'http://agentic.test';
const BASE = '/_sigx/actor';

const codec = {
    encode: (principal: unknown) => JSON.stringify(principal),
    decode: (encoded: string) => (encoded === '' ? null : (JSON.parse(encoded) as unknown))
};

export interface LiveHarness {
    readonly app: TestActorApp;
    readonly transport: ActorTransport;
    readonly Session: ReturnType<typeof defineSessionActor>;
    readonly Routing: ReturnType<typeof defineRoutingActor>;
    /** Serve one wire request in-process. */
    fetch(url: string, init?: RequestInit): Promise<Response>;
    /** An agent in the workspace index, configured for `anthropic-api` (the mock runtime) — returns its id. */
    agent(name: string, role?: string): Promise<AgentId>;
    stop(): Promise<void>;
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

/** Start the host, the wire and the stubbed identity. `agentScript` is the mock runtime every session runs. */
export async function startLive(agentScript: MockAgentOptions = { respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] }): Promise<LiveHarness> {
    const Session = defineSessionActor({ factory: localFactory(mockAgent(agentScript)) });
    const Inbox = defineInbox({ channels: [] });
    const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, inbox: () => Inbox });
    const app = testActorApp([Workspace, AgentActor, Chat, ChatPage, TaskActor, Session, Routing, Inbox, Memory, LedgerActor, AuditActor]);
    await app.start();
    // After `start()` (last-wins seam): the wire authenticates the `x-user` header; hops keep the JSON codec.
    const restore = stubServerApp({
        codec,
        authenticate: (rq: { request?: Request }) => {
            const user = rq.request?.headers.get('x-user');
            return user ? (userPrincipal(user) as Principal) : null;
        }
    });
    const handler = createFetchHandler(app.app, { base: BASE, origin: false });
    const fetch = (url: string, init?: RequestInit): Promise<Response> => handler(new Request(url, init));
    const transport = fetchTransport({
        endpoint: `${ORIGIN}${BASE}`,
        headers: { 'x-user': USER, origin: ORIGIN },
        fetch: (input, init) => fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
    });
    configureActors(transport);
    return {
        app,
        transport,
        Session,
        Routing,
        fetch,
        async agent(name, role = '') {
            const { agentId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createAgent({ name });
            await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name, role, instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
            return agentId;
        },
        async stop() {
            configureActors(null);
            restore();
            await app.stop();
        }
    };
}

const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** Mount a route as ONE browser tab would: refs over the harness transport, the viewer resolved, live mode on. */
export async function mountLive(path: string, harness: LiveHarness, tree: JSXElement = <RouterView />): Promise<HTMLDivElement> {
    setDataMode('live');
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(router);
    app.use(actorsPlugin({ transport: harness.transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
    app.defineProvide(useActorDefs, clientDefs);
    app.defineProvide(useViewer, () => () => ({ workspaceId: USER, pending: false }));
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
        setDataMode('mock');
    });
    return container;
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds. */
export async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await tick(10);
    }
}

export const texts = (els: Iterable<Element>): string[] => [...els].map((el) => el.textContent?.trim() ?? '');
