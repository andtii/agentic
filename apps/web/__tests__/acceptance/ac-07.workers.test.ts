/**
 * AC-07 — A selected machine is offline. The platform follows the
 * configured policy and does not silently change accounts or environments.
 *
 * Inside workerd: a paired machine whose daemon (on a real daemon WebSocket
 * to its Machine Durable Object) reported an environment and then went
 * away. Tasks for that environment are routed through the Routing object
 * under each offline policy of the agent's configuration: `queue` waits
 * `environment-offline` — another machine reporting the SAME environment id
 * is never used — and resumes when ITS machine comes back; `fail` fails with
 * an error that names the policy; `fallback-api` runs on `anthropic-api`
 * only because the configuration says so, through a transition that says
 * why. Deeper: `packages/platform/__tests__/routing/routing.test.ts`
 * (the AC-07 block: adoption of a parked schedule task, EXE-11/12).
 */
import type { EnvironmentId, MachineId, TaskId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { SCENARIO_MS, connectDaemon, daemonFor, edges, opens, signInAs, until, type Actor, type DaemonLink } from './workers';

const E1 = 'env_laptop' as EnvironmentId;

const links: DaemonLink[] = [];
afterEach(() => {
    for (const l of links.splice(0)) l.close();
});

/** A paired machine that reported `E1` from its daemon and then dropped the connection. */
async function offlineMachine(me: Actor, name: string): Promise<{ machineId: MachineId; token: string; daemon: ReturnType<typeof daemonFor> }> {
    const { machineId, token } = await me.pairMachine(name);
    const daemon = daemonFor(machineId, [inMemoryEnvironment(machineId, E1)]);
    const link = await connectDaemon(machineId, token, daemon);
    await link.welcomed();
    await until(async () => (await me.machine(machineId).get()).online, `${name} online`);
    link.close();
    await until(async () => !(await me.machine(machineId).get()).online, `${name} offline`);
    return { machineId, token, daemon };
}

// Each policy first takes a machine online and offline again, then routes: several waits in a row (#179).
describe('AC-07: the selected machine is offline', { timeout: SCENARIO_MS }, () => {
    it('policy queue: the task waits for ITS machine — another machine with the same environment id is not used — and runs there when it returns', async () => {
        const me = await signInAs('ac07_queue');
        const laptop = await offlineMachine(me, 'laptop');
        const agentId = await me.agent('Coder', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'queue' });
        await me.createTask('t_queue', agentId);

        const waiting = await me.routing().run('t_queue' as TaskId);
        expect(waiting.status).toBe('waiting');
        expect(waiting.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'queue' });
        expect(waiting.sessionId).toBeUndefined();
        expect(await me.task('t_queue').explain()).toEqual(waiting.wait);
        expect((await me.routing().get()).routes[0]).toMatchObject({ taskId: 't_queue', status: 'waiting-offline', environmentId: E1, machineId: laptop.machineId });

        // A different machine reporting an environment with the same id changes nothing: the task is bound to the laptop (EXE-12).
        const other = await me.pairMachine('desktop');
        const otherLink = await connectDaemon(other.machineId, other.token, daemonFor(other.machineId, [inMemoryEnvironment(other.machineId, E1)]));
        links.push(otherLink);
        await otherLink.welcomed();
        await until(async () => (await me.machine(other.machineId).get()).online, 'the desktop online');
        await new Promise((r) => setTimeout(r, 150));
        expect((await me.task('t_queue').get()).status).toBe('waiting');
        expect(opens(otherLink)).toEqual([]);
        expect((await me.machine(other.machineId).get()).activeSessions).toEqual([]);

        // The laptop's daemon redials: the route retries there, and only there.
        const back = await connectDaemon(laptop.machineId, laptop.token, laptop.daemon);
        links.push(back);
        await back.welcomed();
        const t = await me.settled('t_queue');
        expect(t.status).toBe('completed');
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[1]!.why).toMatch(/environment env_laptop on machine .* is online/);
        expect((await me.session(t.sessionId!).get()).spec).toMatchObject({ environmentId: E1, machineId: laptop.machineId });
        expect(opens(back).map((o) => o.sessionId)).toEqual([t.sessionId]);
        expect(opens(otherLink)).toEqual([]);
    });

    it('policy fail: the task fails with an error that names the environment and the policy; nothing else is tried', async () => {
        const me = await signInAs('ac07_fail');
        await offlineMachine(me, 'laptop');
        const agentId = await me.agent('Coder', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' });
        await me.createTask('t_fail', agentId);
        const t = await me.routing().run('t_fail' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'environment-offline', recoverable: true });
        expect(t.error!.message).toMatch(/env_laptop .* is offline; the agent's offline policy is "fail"/);
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>failed']);
        expect(t.transitions[0]!.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'fail' });
        expect(t.sessionId).toBeUndefined();
        expect((await me.routing().get()).routes).toEqual([]);
    });

    it('policy fallback-api, only because the configuration says so: runs on anthropic-api through a transition that says why; the task keeps its environment', async () => {
        const me = await signInAs('ac07_fallback');
        await offlineMachine(me, 'laptop');
        const agentId = await me.agent('Coder', { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fallback-api' });
        await me.createTask('t_fallback', agentId, { environmentId: E1 });
        const started = await me.routing().run('t_fallback' as TaskId);
        expect(started.status).toBe('active');
        const t = await me.settled('t_fallback');
        expect(t.status).toBe('completed');
        expect(t.result?.text).toBe('echo: do t_fallback');
        expect(edges(t)).toEqual(['queued>waiting', 'waiting>active', 'active>completed']);
        expect(t.transitions[0]!.wait).toEqual({ kind: 'environment-offline', environmentId: E1, policy: 'fallback-api' });
        expect(t.transitions[1]!.why).toMatch(/^fallback-api: environment env_laptop on machine .* is offline; running on anthropic-api/);
        // The task's own environment is untouched; only the session ran elsewhere, and the record says so.
        expect(t.environmentId).toBe(E1);
        const info = await me.session(t.sessionId!).get();
        expect(info.spec).toMatchObject({ runtime: 'anthropic-api' });
        expect(info.spec?.machineId).toBeUndefined();
    });
});
