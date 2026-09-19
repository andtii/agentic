/**
 * Routing and the session factory over the Registry (#230, architecture §5a, §9;
 * AC-13, EXE-10): `run` asks `gate()` once and a runtime plugin that is turned
 * off opens nothing; the `anthropic-api` key is the workspace's Registry secret,
 * opened once per session open; the plugin's `defaultModel` and the workspace's
 * default environment fill what the agent leaves unsaid. The REAL factory runs
 * over a `mockModel` — the seam replaces the model, never the key lookup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type EnvironmentId, type OfflinePolicy, type RuntimeId, type TaskId, type WorkspaceId } from '@agentic/core';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, ANTHROPIC_MODEL_IDS, CLAUDE_CODE_PLUGIN_ID, anthropicApiPlugin, claudeCodePlugin } from '@agentic/runtimes';
import { mockModel, type MockModel } from '@sigx/ai/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { generateWorkspaceKek, importWorkspaceKek, workspaceKey } from '../../src/auth/index';
import { defineRegistry, registryKey } from '../../src/registry/index';
import { anthropicApiRuntime, createSessionFactory, defineRoutingActor, routingKey, type RuntimeCatalogue, type RuntimeImpl } from '../../src/routing/index';
import { defineSessionActor } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const KEK = generateWorkspaceKek();

let app: TestActorApp;
let model: MockModel;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, claudeCodePlugin] });

beforeEach(async () => {
    model = mockModel({ modelId: 'claude-test', respond: () => ({ text: 'done' }) });
    const runtimes: RuntimeCatalogue = {
        [ANTHROPIC_API_PLUGIN_ID]: anthropicApiRuntime({ routing: () => Routing, sessions: () => Session, model }),
        [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
    };
    Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, registry: () => Registry, runtimes }) });
    // No machine is paired in these tests: an environment nobody reports is "offline" under the agent's policy.
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, registry: () => Registry, runtimes });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor]);
    await app.start();
});
afterEach(() => app.stop());

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const registry = () => app.as(owner).actor(Registry, registryKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const audited = (kind: 'secret.opened' | 'environment.chosen') => app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: [kind] }).then((page) => page.events);

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};
const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);

async function agent(id: string, execution: { runtime: RuntimeId; defaultEnvironmentId?: EnvironmentId; offlinePolicy?: OfflinePolicy; model?: string }): Promise<AgentId> {
    const agentId = id as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: id, instructions: 'Be brief.', tools: [{ name: 'task_report' }], execution: { offlinePolicy: 'fail', ...execution } }, 'create');
    return agentId;
}

async function run(id: string, assignee: AgentId): Promise<TaskView> {
    await task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {} }, { owner: assignee });
    return routing().run(id as TaskId);
}

describe('a runtime plugin that is turned off (AC-13)', () => {
    it('opens no session and fails the task plugin-disabled; turned on again, the next task runs', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        const a = await agent('atlas', { runtime: 'anthropic-api' });
        await registry().disable(ANTHROPIC_API_PLUGIN_ID);

        const refused = await run('t1', a);
        expect(refused.status).toBe('failed');
        expect(refused.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(refused.error!.message).toContain(ANTHROPIC_API_PLUGIN_ID);
        expect(refused.sessionId).toBeUndefined();
        expect(model.requests).toHaveLength(0);
        expect((await routing().get()).routes).toEqual([]);
        expect(await audited('secret.opened')).toHaveLength(0);

        await registry().enable(ANTHROPIC_API_PLUGIN_ID);
        expect((await run('t2', a)).status).toBe('active');
        await settled('t2');
        expect((await task('t2').get()).status).toBe('completed');
    });

    it('a parked schedule firing goes through the same gate: no separate check in the trigger', async () => {
        const a = await agent('cc', { runtime: 'claude-code', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await registry().disable(CLAUDE_CODE_PLUGIN_ID);
        await task('t1').create({ objective: 'nightly', origin: { kind: 'external', clientId: 'c1' }, assignee: a, environmentId: E1, context: [], constraints: {} }, { owner: a });
        // What `scheduleTrigger` leaves for the router when the environment is offline at the firing (#42).
        await task('t1').reportWaiting({ kind: 'environment-offline', environmentId: E1, policy: 'queue' }, 'schedule:sch_1');
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect((await routing().get()).routes).toEqual([]);
    });

    it('a runtime nobody installed is refused by the gate before the catalogue is even asked', async () => {
        const a = await agent('ghost', { runtime: 'no-such-runtime', defaultEnvironmentId: E1 });
        const t = await run('t1', a);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'plugin-disabled' });
    });

    it('fallback-api asks the gate for anthropic-api before the task leaves its environment', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        const a = await agent('cc', { runtime: 'claude-code', defaultEnvironmentId: E1, offlinePolicy: 'fallback-api' });
        await registry().disable(ANTHROPIC_API_PLUGIN_ID);
        const refused = await run('t1', a);
        expect(refused.status).toBe('failed');
        expect(refused.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(refused.error!.message).toContain('fallback-api');
        expect(model.requests).toHaveLength(0);

        await registry().enable(ANTHROPIC_API_PLUGIN_ID);
        await run('t2', a);
        await settled('t2');
        const t = await task('t2').get();
        expect(t.status).toBe('completed');
        const info = await session(t.sessionId!).get();
        expect(info.spec).toMatchObject({ runtime: 'anthropic-api', plugins: { runtime: { id: ANTHROPIC_API_PLUGIN_ID, enabled: true } } });
    });
});

describe('the anthropic-api key is the Registry secret (EXE-10)', () => {
    it('without the secret the open fails no-api-key and names the plugin page', async () => {
        const a = await agent('atlas', { runtime: 'anthropic-api' });
        const t = await run('t1', a);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'session-open' });
        expect(t.error!.message).toContain('no-api-key');
        expect(t.error!.message).toContain('/plugins/anthropic-api');
        expect(model.requests).toHaveLength(0);
    });

    it('with the secret the task runs, and secret.opened is recorded once for the session open', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        const a = await agent('atlas', { runtime: 'anthropic-api' });
        await run('t1', a);
        await settled('t1');
        expect((await task('t1').get()).status).toBe('completed');
        expect(model.requests.length).toBeGreaterThan(0);
        await until(async () => (await audited('secret.opened')).length > 0, 'secret.opened in the audit log');
        const opened = await audited('secret.opened');
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ data: { name: ANTHROPIC_API_KEY_SECRET, pluginId: ANTHROPIC_API_PLUGIN_ID } });
        // The plaintext is nowhere on the records the router and the session keep.
        const info = await session((await task('t1').get()).sessionId!).get();
        expect(JSON.stringify(info)).not.toContain('sk-ant-test');
    });

    it('a secret the plugin may no longer open fails the open, not the workspace', async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await registry().revoke(ANTHROPIC_API_PLUGIN_ID, [`secret:${ANTHROPIC_API_KEY_SECRET}`]);
        const a = await agent('atlas', { runtime: 'anthropic-api' });
        const t = await run('t1', a);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'session-open' });
        expect(t.error!.message).toContain('secret:anthropic-api-key');
    });
});

describe('what the gate answered rides on the route and the spec (§9)', () => {
    // The plugin's schema default comes first in the list; any other id is a choice the owner made.
    const [DEFAULT_ANTHROPIC_MODEL, OTHER] = ANTHROPIC_MODEL_IDS as [string, string];

    it("applies the plugin's defaultModel when the agent names none, and keeps the agent's own", async () => {
        await registry().setSecret(ANTHROPIC_API_KEY_SECRET, 'sk-ant-test');
        await registry().configure(ANTHROPIC_API_PLUGIN_ID, { defaultModel: OTHER });
        const quiet = await agent('quiet', { runtime: 'anthropic-api' });
        const named = await agent('named', { runtime: 'anthropic-api', model: DEFAULT_ANTHROPIC_MODEL });
        await run('t1', quiet);
        await run('t2', named);
        await settled('t1');
        await settled('t2');
        const spec = async (id: string) => (await session((await task(id).get()).sessionId!).get()).spec!;
        expect((await spec('t1')).config.execution.model).toBe(OTHER);
        expect((await spec('t1')).plugins).toMatchObject({ runtime: { id: ANTHROPIC_API_PLUGIN_ID, enabled: true, config: { defaultModel: OTHER } }, channels: [] });
        expect((await spec('t2')).config.execution.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    });
});

describe("the workspace's default environment (AGT-05)", () => {
    it('is where a daemon-runtime task runs when neither the task nor the agent names one', async () => {
        const a = await agent('cc', { runtime: 'claude-code', offlinePolicy: 'fail' });
        const before = await run('t1', a);
        expect(before.error).toMatchObject({ code: 'no-environment' });

        await app.as(owner).actor(Workspace, workspaceKey(WS)).updateSettings({ defaults: { runtime: 'claude-code', environmentId: E1 } });
        const t = await run('t2', a);
        // Nobody reports env_1 here: the point is that the router chose it, and said where it came from.
        expect(t.error).toMatchObject({ code: 'environment-offline' });
        await until(async () => (await audited('environment.chosen')).length > 0, 'environment.chosen in the audit log');
        const chosen = await audited('environment.chosen');
        expect(chosen[0]).toMatchObject({ taskId: 't2', data: { environmentId: E1 } });
        expect(chosen[0]!.summary).toContain("the workspace's default");
    });
});

describe('the runtime catalogue', () => {
    it('the factory answers null for a daemon runtime and refuses an id the build does not have', async () => {
        const factory = createSessionFactory({ routing: () => Routing, runtimes: { [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' } } });
        const context = {} as Parameters<typeof factory>[1];
        expect(await factory(CLAUDE_CODE_PLUGIN_ID, context)).toBeNull();
        await expect(factory('no-such-runtime', context)).rejects.toThrow(/^unknown-runtime: /);
    });

    it('without a Registry the router still fails a runtime the catalogue does not know, before any environment is looked for', async () => {
        await app.stop();
        const runtimes: RuntimeCatalogue = { [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' } };
        Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, runtimes }) });
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, runtimes });
        app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace]);
        await app.start();
        const a = await agent('ghost', { runtime: 'no-such-runtime' });
        const t = await run('t1', a);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'unknown-runtime', recoverable: false });
    });
});

describe('a secret asked for after the gate', () => {
    /** A local runtime that only asks for a secret — what any runtime with a key does first. */
    const asking: RuntimeImpl = {
        host: 'local',
        async open(_context, plugin) {
            await plugin.secret('token');
            throw new Error('the secret was handed out');
        }
    };

    it('fails the task plugin-disabled either way, and the message tells a plugin that is not installed from one that is turned off', async () => {
        await app.stop();
        const runtimes: RuntimeCatalogue = { ghost: asking, [ANTHROPIC_API_PLUGIN_ID]: asking };
        Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, registry: () => Registry, runtimes }) });
        // A router without the Registry: nothing is gated, so the open is where the plugin answers — as when it is turned off between the two.
        Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, runtimes });
        app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Registry, AuditActor]);
        await app.start();

        const missing = await run('t1', await agent('ghost', { runtime: 'ghost' }));
        expect(missing.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(missing.error!.message).toContain('no "ghost" runtime plugin is installed');

        await registry().disable(ANTHROPIC_API_PLUGIN_ID);
        const off = await run('t2', await agent('atlas', { runtime: 'anthropic-api' }));
        expect(off.error).toMatchObject({ code: 'plugin-disabled', recoverable: true });
        expect(off.error!.message).toContain('the "anthropic-api" runtime plugin is turned off');
    });
});
