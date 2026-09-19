/**
 * AC-02 — One machine has three accounts for the same supported runtime.
 * The user can choose each environment; execution does not change another
 * environment's authentication.
 *
 * Inside workerd: one paired machine whose daemon (on a real daemon
 * WebSocket to its Machine Durable Object) reports three environments of
 * the same runtime, one account each, isolated by config dir; three tasks,
 * each choosing one environment, routed through the Routing object to that
 * machine. Every session opens on exactly the environment its task chose,
 * and afterwards the machine reports every account exactly as before.
 * Deeper: `packages/platform/__tests__/routing/routing.test.ts` (the AC-02
 * block, in process) and `packages/runtimes/__tests__/claude-code/isolation.test.ts`
 * (the spawn env of the Claude Code driver differs only in its profile).
 */
import type { EnvironmentDescriptor, EnvironmentId, MachineId, TaskId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { SCENARIO_MS, connectDaemon, daemonFor, opens, signInAs, until, type DaemonLink } from './workers';

const E = ['env_work', 'env_personal', 'env_client'] as EnvironmentId[];

/** One account per environment, isolated by its own config dir, with the doctor verdict the daemon's `hello` carries. */
const account = (machineId: MachineId, id: EnvironmentId, label: string, identity: string): EnvironmentDescriptor => ({
    ...inMemoryEnvironment(machineId, id),
    name: label,
    account: { label, authStatus: 'ok', identity },
    isolation: 'config-dir',
    doctor: { ok: true, findings: [{ level: 'info', code: 'auth-ok', message: `${label}: signed in`, environmentIds: [id] }], checkedAt: 1 }
});

const links: DaemonLink[] = [];
afterEach(() => {
    for (const l of links.splice(0)) l.close();
});

// A pairing, a daemon link and three routed runs: several waits in a row (#179).
describe('AC-02: three accounts of one runtime on one machine', { timeout: SCENARIO_MS }, () => {
    it('each is selectable, a session opens on the environment its task chose, and no run touches another account', async () => {
        const me = await signInAs('ac02_user');
        const { machineId, token } = await me.pairMachine('laptop');
        const link = await connectDaemon(machineId, token, daemonFor(machineId, [account(machineId, E[0]!, 'work', 'me@work.example'), account(machineId, E[1]!, 'personal', 'me@home.example'), account(machineId, E[2]!, 'client', 'me@client.example')]));
        links.push(link);
        await link.welcomed();
        await until(async () => (await me.machine(machineId).get()).online, 'the machine online');

        // The three accounts, as the user sees them before anything runs.
        const before = (await me.machine(machineId).get()).environments;
        expect(before.map((e) => [e.id, e.runtime, e.account.identity, e.isolation])).toEqual([
            [E[0], 'in-memory', 'me@work.example', 'config-dir'],
            [E[1], 'in-memory', 'me@home.example', 'config-dir'],
            [E[2], 'in-memory', 'me@client.example', 'config-dir']
        ]);
        const verdicts = await me.machine(machineId).doctor();
        expect(verdicts).toMatchObject({ machineId, online: true, ok: true, unverified: [] });

        // One agent on the runtime; each task picks its own environment (the user's choice).
        const agentId = await me.agent('Coder', { runtime: 'in-memory', defaultEnvironmentId: E[0] });
        const picks: [string, EnvironmentId][] = [
            ['t_work', E[0]!],
            ['t_personal', E[1]!],
            ['t_client', E[2]!]
        ];
        for (const [id, environmentId] of picks) await me.createTask(id, agentId, { environmentId });
        // One at a time, then two at once on the same machine (#106): every run leaves the others' accounts untouched.
        expect((await me.routing().run('t_work' as TaskId)).status).toBe('active');
        await me.settled('t_work');
        await me.routing().run('t_personal' as TaskId);
        await me.routing().run('t_client' as TaskId);
        await Promise.all([me.settled('t_personal'), me.settled('t_client')]);

        const sessionOpens = opens(link);
        expect(sessionOpens).toHaveLength(3);
        for (const [id, environmentId] of picks) {
            const t = await me.task(id).get();
            expect(t.status).toBe('completed');
            expect(t.environmentId).toBe(environmentId);
            const info = await me.session(t.sessionId!).get();
            expect(info.spec).toMatchObject({ runtime: 'in-memory', environmentId, machineId });
            expect(info.mode).toBe('remote');
            // The daemon was told exactly that environment for this session: the account is the task's choice, never switched (EXE-12).
            expect(sessionOpens.filter((o) => o.sessionId === t.sessionId).map((o) => o.environmentId)).toEqual([environmentId]);
        }

        // Execution changed no account: what the machine reports is what it reported before (EXE-05).
        const after = (await me.machine(machineId).get()).environments;
        const shape = (e: EnvironmentDescriptor) => ({ id: e.id, account: e.account, isolation: e.isolation, doctor: e.doctor });
        expect(after.map(shape)).toEqual(before.map(shape));
        expect((await me.machine(machineId).doctor()).environments.map((e) => [e.environmentId, e.account.identity, e.verdict?.ok])).toEqual([
            [E[0], 'me@work.example', true],
            [E[1], 'me@home.example', true],
            [E[2], 'me@client.example', true]
        ]);
        await until(async () => (await me.machine(machineId).get()).activeSessions.length === 0, 'every slot to free');
    });
});
