/**
 * Demo 1 inside workerd (#35) — the `smoke:demo1` walk-through over the
 * production wiring with the mock model: sign in through the preview dev
 * login, create an agent the way the roster's dialog does, save a config
 * version the way the Config tab does, open a direct chat the way "Start
 * chat" does, post, and see the answer on the chat's live view.
 */
import type { AgentId, ChatId, TaskId, WorkspaceId } from '@agentic/core';
import { createId } from '@agentic/core';
import { AgentActor, Chat, TaskActor, Workspace, type IndexedEntry, type RoutingActor } from '@agentic/platform';
import { fetchTransport } from '@sigx/actors/client';
import { SELF } from 'cloudflare:test';
import { agentKeyOf, chatKeyOf, routingKeyOf, taskKeyOf, workspaceKeyOf } from '../../src/actors/keys';
import { DEV_LOGIN_PATH } from '../../src/auth/dev-login';
import { runActivation, unknownAgent } from '../../src/pages/chat/live';
import { configPatch, CREATED_REASON, newAgentPatch } from '../../src/pages/agent/live';
import { overHttp, setAnthropicKey } from './http';
import { TEST_DEV_LOGIN } from './secret';

const ORIGIN = 'https://agentic.test';
const Routing = { type: 'routing' } as unknown as RoutingActor;

async function devLogin(user: string, token = TEST_DEV_LOGIN): Promise<Response> {
    return SELF.fetch(`${ORIGIN}${DEV_LOGIN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, user }) });
}

function liveRead(cookie: string, wire: { t: string; k: string; m: string; a?: readonly unknown[] }): { values: unknown[]; stop(): void } {
    const transport = fetchTransport({ endpoint: `${ORIGIN}/_sigx/actor`, headers: { cookie, origin: ORIGIN }, fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : (input as URL).href, init) });
    const controller = new AbortController();
    const values: unknown[] = [];
    void (async () => {
        try {
            for await (const frame of transport.stream('$live#subscribe', [[wire]], { signal: controller.signal })) {
                const f = frame as { i?: number; v?: unknown; e?: unknown };
                if (f.i === 0 && 'v' in f) values.push(f.v);
                if (f.e) throw new Error(JSON.stringify(f.e));
            }
        } catch (e) {
            if (!controller.signal.aborted) throw e;
        }
    })();
    return { values, stop: () => controller.abort() };
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe('worker: demo 1 — dev login, new agent, config save, direct chat, answer', () => {
    it('refuses the dev login with a wrong token and never sets a cookie', async () => {
        const res = await devLogin('demo1', 'not-the-token-at-all-0123456789');
        expect(res.status).toBe(403);
        expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('walks the demo end to end on the live view', async () => {
        const login = await devLogin('demo1');
        expect(login.status).toBe(200);
        const { principal } = (await login.json()) as { principal: { userId: string; workspaceId: string } };
        expect(principal).toEqual({ kind: 'user', userId: 'dev_demo1', workspaceId: 'dev_demo1' });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const WS = principal.workspaceId as WorkspaceId;

        // `/plugins/anthropic-api`: the workspace's own key (#231) — the deployment holds none.
        await setAnthropicKey(WS, cookie);

        // The roster's "New agent": the index record, then v1 on the platform runtime.
        const ws = overHttp(Workspace, workspaceKeyOf(WS), cookie);
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        const agent = overHttp(AgentActor, agentKeyOf(WS, agentId), cookie);
        const v1 = await agent.update(newAgentPatch({ name: 'Ada', role: 'Demo assistant' }), CREATED_REASON);
        expect(v1).toMatchObject({ version: 1, reason: CREATED_REASON, by: 'user:dev_demo1' });
        expect((await ws.get()).agents).toEqual([agentId]);

        // The Config tab's save: the whole form config as v2.
        const view = await agent.get();
        expect(view.config).toMatchObject({ name: 'Ada', role: 'Demo assistant', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } });
        const v2 = await agent.update(configPatch({ ...view.config, instructions: 'Be brief. Answer in one sentence.' }), 'Edited in the web UI');
        expect(v2.version).toBe(2);
        expect((await agent.listVersions()).map((v) => v.version)).toEqual([1, 2]);
        expect((await agent.get()).config.instructions).toBe('Be brief. Answer in one sentence.');

        // "Start chat": a direct chat with the agent as its only member.
        const { chatId } = await ws.createChat({});
        const chatKey = chatKeyOf(WS, chatId as ChatId);
        const chat = overHttp(Chat, chatKey, cookie);
        await chat.addAgent(agentId as AgentId, 'all');

        const live = liveRead(cookie, { t: 'Chat', k: chatKey, m: 'history', a: [null, 50] });
        await until(() => live.values.length >= 1, 'the first live value');
        const summary = await chat.get();
        const result = await runActivation(
            {
                post: (text, mentions) => chat.post(text, mentions),
                createTask: (id, contract, owner) => overHttp(TaskActor, taskKeyOf(WS, id), cookie).create(contract, { owner }),
                run: (taskId) => overHttp(Routing, routingKeyOf(WS), cookie).run(taskId),
                newTaskId: () => createId('task') as TaskId
            },
            { chatId: chatId as ChatId, text: 'Say hello in five words.', mentions: [], summary, entries: [], lookup: unknownAgent }
        );
        expect(result.tasks.map((t) => t.agentId)).toEqual([agentId]);

        const entries = (): IndexedEntry[] => ((live.values[live.values.length - 1] as { entries: IndexedEntry[] } | undefined)?.entries ?? []);
        await until(() => entries().some((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent'), 'the answer on the live view');
        live.stop();
        const answer = entries().find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent')!.entry as Extract<IndexedEntry['entry'], { t: 'msg' }>;
        expect(answer.parts).toEqual([{ type: 'text', text: 'echo: Say hello in five words.' }]);
        expect(answer.taskId).toBe(result.tasks[0]!.taskId);
    });
});
