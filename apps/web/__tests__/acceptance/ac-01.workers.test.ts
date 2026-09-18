/**
 * AC-01 — A user registers two machines. Both appear with independently
 * reported environments and availability.
 *
 * Inside workerd: two machines registered and paired through the Workspace,
 * two daemons on real daemon WebSockets to their Machine Durable Objects,
 * each reporting its own environments in `hello`; the workspace lists both,
 * each Machine reports what ITS daemon said, and one going away changes
 * nothing about the other. Deeper: `packages/platform/__tests__/machine/actor.test.ts`
 * (the Machine actor's daemon protocol) and `../workers/daemon.test.ts`
 * (the socket's auth: tokens, revocation).
 */
import type { EnvironmentId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { connectDaemon, daemonFor, signInAs, until, type DaemonLink } from './workers';

const links: DaemonLink[] = [];
afterEach(() => {
    for (const l of links.splice(0)) l.close();
});

describe('AC-01: two registered machines', () => {
    it('both appear, with independently reported environments and availability', async () => {
        const me = await signInAs('ac01_user');
        const laptop = await me.pairMachine('laptop');
        const desktop = await me.pairMachine('desktop');

        // Registered and paired: the workspace lists both before either daemon has connected.
        const listed = await me.workspace().listMachines();
        expect(listed.map((m) => [m.name, m.status])).toEqual([
            ['laptop', 'paired'],
            ['desktop', 'paired']
        ]);
        expect((await me.machine(laptop.machineId).get()).online).toBe(false);
        expect((await me.machine(desktop.machineId).get()).online).toBe(false);

        // Each daemon reports its own environments; the laptop has one account, the desktop two — one not signed in.
        const laptopEnv = { ...inMemoryEnvironment(laptop.machineId, 'env_laptop' as EnvironmentId), name: 'work', account: { label: 'work', authStatus: 'ok' as const } };
        const desktopWork = { ...inMemoryEnvironment(desktop.machineId, 'env_desktop_work' as EnvironmentId), name: 'work', account: { label: 'work', authStatus: 'ok' as const } };
        const desktopHome = { ...inMemoryEnvironment(desktop.machineId, 'env_desktop_home' as EnvironmentId), name: 'home', account: { label: 'home', authStatus: 'missing' as const } };
        const a = await connectDaemon(laptop.machineId, laptop.token, daemonFor(laptop.machineId, [laptopEnv]));
        const b = await connectDaemon(desktop.machineId, desktop.token, daemonFor(desktop.machineId, [desktopWork, desktopHome]));
        links.push(a, b);
        expect(await a.welcomed()).toMatchObject({ t: 'welcome' });
        expect(await b.welcomed()).toMatchObject({ t: 'welcome' });

        const viewA = await me.machine(laptop.machineId).get();
        const viewB = await me.machine(desktop.machineId).get();
        expect(viewA).toMatchObject({ name: 'laptop', online: true, os: 'linux', daemonVersion: '0.0.0-fake' });
        expect(viewA.environments.map((e) => [e.id, e.account.authStatus])).toEqual([['env_laptop', 'ok']]);
        expect(viewB).toMatchObject({ name: 'desktop', online: true });
        expect(viewB.environments.map((e) => [e.id, e.account.authStatus])).toEqual([
            ['env_desktop_work', 'ok'],
            ['env_desktop_home', 'missing']
        ]);
        // Nothing of one machine leaks into the other's record.
        expect(viewA.environments.every((e) => e.machineId === laptop.machineId)).toBe(true);
        expect(viewB.environments.every((e) => e.machineId === desktop.machineId)).toBe(true);

        // Availability is per machine: the laptop's daemon goes away, the desktop stays online with its environments.
        a.close();
        await until(async () => !(await me.machine(laptop.machineId).get()).online, 'the laptop to go offline');
        const stillB = await me.machine(desktop.machineId).get();
        expect(stillB.online).toBe(true);
        expect(stillB.environments).toHaveLength(2);
        // The offline machine keeps what it last reported, so the user can still see what it offers.
        expect((await me.machine(laptop.machineId).get()).environments.map((e) => e.id)).toEqual(['env_laptop']);
        expect((await me.workspace().listMachines()).map((m) => m.name)).toEqual(['laptop', 'desktop']);
    });
});
