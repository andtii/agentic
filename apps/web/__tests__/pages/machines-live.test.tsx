/**
 * The Machines, Machine and Pair pages on the live harness (#144): two
 * paired machines with independently reported environments, a socket drop
 * flipping one offline, the doctor checklist from the daemon's verdicts,
 * revoke through the page (the next daemon message is refused), a code
 * minted by the Pair page and redeemed the way `POST /auth/pair` does, and
 * the agent Config tab's environment picker saving `defaultEnvironmentId`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, MachineId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { AgentActor, Workspace, machineKey, workspaceKey, type MachineDoctorView, type MachineView } from '@agentic/platform';
import { agentKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { machineHead } from '../../src/pages/machines/head';
import { defaultForByEnvironment, doctorChecksOf, environmentOptions, machineOf, pairCommands, queuedByEnvironment, secondsLeft, seenLabel, sessionsOf } from '../../src/pages/machines/live';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const button = (root: ParentNode, label: string): HTMLButtonElement => {
    // Closed dialogs stay in the DOM: outside a dialog, never pick a button inside one.
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};

const env = (machineId: MachineId, id: string, name: string, authStatus: EnvironmentDescriptor['account']['authStatus'], doctor?: EnvironmentDescriptor['doctor']): EnvironmentDescriptor => ({
    ...inMemoryEnvironment(machineId, id as EnvironmentId),
    name,
    runtime: 'claude-code',
    account: { label: name, authStatus },
    isolation: 'config-dir',
    ...(doctor ? { doctor } : {})
});

const hello = (machineId: MachineId, environments: readonly EnvironmentDescriptor[]): string =>
    JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments, capabilities: [IN_MEMORY_CAPABILITIES], resume: {} });

/** Register + pair a machine the way the Pair page and `POST /auth/pair` do; returns its id and the daemon-side client. */
async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    return { machineId, daemon, user: h.app.as(owner).actor(h.Machine, machineKey(WS, machineId)) };
}

const groups = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-machine-group]:not([data-platform])')];
const groupOf = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-machine-group][data-machine="${id}"]`);

describe('/machines on the live pages', () => {
    it('lists the paired machines with their own environments; a socket drop flips one offline (AC-01)', { timeout: 15_000 }, async () => {
        const laptop = await pairMachine('laptop');
        const desktop = await pairMachine('desktop');
        await laptop.daemon.socketMessage(hello(laptop.machineId, [env(laptop.machineId, 'env_laptop_work', 'work', 'ok')]));
        await desktop.daemon.socketMessage(hello(desktop.machineId, [env(desktop.machineId, 'env_desktop_work', 'work', 'ok'), env(desktop.machineId, 'env_desktop_home', 'home', 'missing')]));

        const dom = await mountLive('/machines', h);
        await until(() => groups(dom).length === 2 && groups(dom).every((g) => !g.hasAttribute('aria-busy')), 'both machine groups');
        expect(groups(dom).map((g) => g.getAttribute('aria-label'))).toEqual(['laptop', 'desktop']);
        expect(groups(dom).map((g) => g.hasAttribute('data-online'))).toEqual([true, true]);
        // Each group carries what ITS daemon reported.
        const cards = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('[data-scope="ag-env-card"][data-part="root"]')];
        expect(cards(groupOf(dom, laptop.machineId)!).map((c) => c.getAttribute('aria-label'))).toEqual(['work']);
        expect(cards(groupOf(dom, desktop.machineId)!).map((c) => [c.getAttribute('aria-label'), c.getAttribute('data-env-state')])).toEqual([
            ['work', 'ready'],
            ['home', 'auth-missing']
        ]);
        expect(groupOf(dom, laptop.machineId)!.querySelector('[data-machine-caption]')!.textContent).toContain('Windows · daemon 0.1.0-test · heartbeat');
        // The platform row stays, with no machine of its own.
        expect(dom.querySelector('[data-machine-group][data-platform] [data-machine-name]')!.textContent).toBe('platform');
        expect(dom.querySelector('[data-scope="ag-empty"]')).toBeNull();

        // The laptop's socket drops: offline at once, its cards dimmed; the desktop is untouched.
        await laptop.daemon.socketClosed();
        await until(() => !groupOf(dom, laptop.machineId)!.hasAttribute('data-online'), 'the laptop offline');
        expect(groupOf(dom, laptop.machineId)!.querySelector('[data-machine-caption]')!.textContent).toContain('last seen');
        expect(cards(groupOf(dom, laptop.machineId)!).map((c) => c.getAttribute('data-env-state'))).toEqual(['offline']);
        expect(groupOf(dom, desktop.machineId)!.hasAttribute('data-online')).toBe(true);
        expect(cards(groupOf(dom, desktop.machineId)!).map((c) => c.getAttribute('data-env-state'))).toEqual(['ready', 'auth-missing']);
    });

    it('with no paired machine shows the platform row and the "Pair a machine" card; a pending registration is not a machine yet', async () => {
        await h.app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'someday' });
        const dom = await mountLive('/machines', h);
        await until(() => dom.querySelector('[data-scope="ag-empty"][data-part="root"]') !== null, 'the empty card');
        expect(dom.querySelector('[data-scope="ag-empty"][data-part="root"]')!.getAttribute('data-empty')).toBe('machines');
        expect(groups(dom)).toHaveLength(0);
        expect(dom.querySelector('[data-machine-group][data-platform]')).not.toBeNull();
    });
});

describe('/machines/:id on the live pages', () => {
    it('renders the hero, the environments, the doctor verdicts and revokes through the page — the next daemon message is refused', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        const checkedAt = Date.parse('2026-09-17T12:00:00Z');
        await m.daemon.socketMessage(hello(m.machineId, [
            env(m.machineId, 'env_work', 'work', 'ok', { ok: true, findings: [], checkedAt }),
            env(m.machineId, 'env_acme', 'client-acme', 'expired', { ok: false, findings: [{ level: 'error', code: 'auth-expired', message: 'client-acme cannot authenticate' }], checkedAt })
        ]));

        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the machine page');
        expect(dom.querySelector('[data-machine-hero] [data-machine-name]')!.textContent).toBe('alien01');
        expect(dom.querySelector('[data-machine-hero] [data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('ONLINE');
        expect([...dom.querySelectorAll('[data-scope="ag-env-card"][data-part="root"]')].map((c) => [c.getAttribute('aria-label'), c.getAttribute('data-env-state')])).toEqual([
            ['work', 'ready'],
            ['client-acme', 'auth-expired']
        ]);
        // The topbar reads the same record.
        expect(machineHead.value?.name).toBe('alien01');
        expect(topbarFor({ name: 'machine', path: `/machines/${m.machineId}`, params: { id: m.machineId } })?.crumb).toBe('alien01');
        // The doctor checklist: isolation, then each environment's sign-in and verdict with its findings.
        const checks = [...dom.querySelectorAll<HTMLElement>('[data-doctor-check]')].map((c) => [c.querySelector('[data-doctor-text]')!.textContent, c.hasAttribute('data-ok')]);
        expect(checks).toEqual([
            ['Each environment has its own profile directory', true],
            ['work can authenticate', true],
            ["work passed the daemon's doctor", true],
            ['client-acme can authenticate', false],
            ["client-acme passed the daemon's doctor", false],
            ['client-acme cannot authenticate', false]
        ]);
        expect(dom.querySelector('[data-doctor-foot]')!.textContent).toContain('agentic-daemon doctor');
        expect(dom.querySelector('[data-machine-sessions] [data-scope="ag-empty"]')).not.toBeNull();

        // Revoke: the confirm dialog, then `Machine.revoke` — the record says so, and so does the page.
        button(dom, 'Revoke alien01').click();
        await tick();
        const popup = document.querySelector('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
        expect(popup.textContent).toContain('No session is running on it.');
        button(popup, 'Revoke alien01').click();
        await until(async () => (await m.user.get()).revoked, 'the record revoked');
        await until(() => dom.querySelector('[data-revoked-line]') !== null, 'the revoked line');
        expect(dom.querySelector('[data-machine-hero]')!.hasAttribute('data-revoked')).toBe(true);
        expect(dom.querySelector('[data-machine-hero] [data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('REVOKED');
        // The revoke card no longer offers it (the page's other danger button removes the machine from the workspace).
        expect([...dom.querySelectorAll('[aria-label="Revoke"] button')].filter((b) => !b.closest('[data-part="popup"]'))).toHaveLength(0);
        // The daemon's next message is refused: revoke stops the token at once.
        expect(await m.daemon.socketMessage(hello(m.machineId, []))).toEqual({ ok: false, code: 'revoked', message: 'the machine is revoked' });
        expect(await m.user.get()).toMatchObject({ revoked: true, online: false });
    });

    it('an id nobody paired gets the not-paired card', async () => {
        const dom = await mountLive('/machines/nope', h);
        await until(() => dom.querySelector('[data-scope="ag-empty"]') !== null, 'the card');
        expect(dom.querySelector('[data-scope="ag-empty"]')!.textContent).toContain('No paired machine with id nope');
    });
});

describe('/pair on the live pages', () => {
    it('mints a code from the Workspace, shows the daemon command, re-mints on rename, and lands on the machine once the daemon redeems it', { timeout: 15_000 }, async () => {
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const dom = await mountLive('/pair', h);
        await until(() => dom.querySelector('[data-code-cell]') !== null, 'the code');
        const code = () => texts(dom.querySelectorAll('[data-code-cell]')).join('');
        expect(code()).toMatch(/^[A-Z2-9]{6}$/);
        // The index holds the pending registration under the default name, with THIS code.
        let index = await ws.get();
        expect(index.machines).toHaveLength(1);
        expect(index.machines[0]).toMatchObject({ name: 'machine-1', status: 'pending', pairing: { code: code() } });
        const machineId = index.machines[0]!.id;
        expect(dom.querySelector<HTMLInputElement>('[data-pair-name] input')!.value).toBe('machine-1');
        // The commands carry the code, this origin and the name; the countdown runs from ten minutes.
        const wells = texts(dom.querySelectorAll('[data-command-well] code'));
        expect(wells[0]).toBe(`powershell -ExecutionPolicy Bypass -File install.ps1 -Url ${location.origin} -Code ${code()} -Name machine-1`);
        expect(wells[1]).toBe(`agentic-daemon pair ${code()} --url ${location.origin} --name machine-1`);
        expect(dom.querySelector('[data-code-status]')!.textContent).toContain('Waiting for the daemon');
        expect(dom.querySelector('[data-code-status]')!.textContent).toMatch(/09:5\d|10:00/);

        // Renaming issues a fresh code under the new name; the old registration stays pending until it expires.
        const input = dom.querySelector<HTMLInputElement>('[data-pair-name] input')!;
        input.value = 'laptop';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const first = code();
        await until(() => code() !== first, 'a new code');
        index = await ws.get();
        expect(index.machines.map((m) => [m.name, m.status])).toEqual([['machine-1', 'pending'], ['laptop', 'pending']]);
        expect(index.machines[1]!.pairing!.code).toBe(code());
        expect(texts(dom.querySelectorAll('[data-command-well] code'))[1]).toContain('--name laptop');

        // The daemon redeems it (what `POST /auth/pair` does with the code): the page moves to the new machine.
        const newId = index.machines[1]!.id;
        expect(newId).not.toBe(machineId);
        const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId: newId }).actor(h.Machine, machineKey(WS, newId));
        const paired = await daemon.pair(code(), { name: 'laptop', os: 'linux' });
        expect(paired.machineId).toBe(newId);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the machine page');
        expect(dom.querySelector('[data-machine-hero] [data-machine-name]')!.textContent).toBe('laptop');
        expect(dom.querySelector('[data-machine-hero] [data-scope="ag-pill"] [data-part="label"]')!.textContent).toBe('OFFLINE');
        // The daemon has not connected yet: the environments section says so.
        expect(dom.querySelector('[data-machine-envs] [data-scope="ag-empty"]')!.textContent).toContain('has not connected yet');
        // A used code is refused.
        await expect(daemon.pair(code(), { name: 'laptop' })).rejects.toThrow(/already paired/);
    });
});

describe('provider limits on the live pages (#270)', () => {
    it('a quota frame from the daemon reaches the environment card and the /usage Limits', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await m.daemon.socketMessage(hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok'), env(m.machineId, 'env_personal', 'personal', 'ok')]));
        const snapshot = {
            sourceId: 'agentic.quota.claude-code',
            runtime: 'claude-code',
            environmentId: 'env_work',
            plan: 'max',
            availability: 'reported',
            windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', status: 'ok' }],
            observedAt: Date.now(),
            via: 'probe'
        };
        await m.daemon.socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'quota', environmentId: 'env_work', snapshot }));

        const machines = await mountLive('/machines', h);
        const used = () => machines.querySelector('[aria-label="work"] [data-scope="ag-env-card"][data-part="quota"] [data-scope="ag-quota"][data-part="used"]');
        await until(() => used() !== null, 'the work card quota');
        expect(used()!.textContent).toBe('76% used');
        expect(machines.querySelector('[aria-label="personal"] [data-scope="ag-env-card"][data-part="quota"]')!.textContent).toContain('No usage reported yet');

        const usage = await mountLive('/usage', h);
        await until(() => usage.querySelector('[data-limit-account="env_work"] [data-scope="ag-quota"]') !== null, 'the /usage limits');
        expect(usage.querySelector('[data-limit-account="env_work"] [data-limit-caption]')!.textContent).toBe('alien01 · claude-code');
    });
});

describe('the agent Config tab’s environment picker on the live pages', () => {
    it('offers every paired machine’s environments and saves execution.defaultEnvironmentId', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await m.daemon.socketMessage(hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok'), env(m.machineId, 'env_personal', 'personal', 'ok')]));
        const agentId = await h.agent('Forge', 'Builder');
        const dom = await mountLive(`/agents/${agentId}?tab=config`, h);
        await until(() => dom.querySelector('form[data-form="agent"]') !== null, 'the config form');
        const select = () => dom.querySelector<HTMLSelectElement>('form[data-form="agent"] select[name="environment"]')!;
        await until(() => select().options.length >= 3, 'the environment options');
        expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([
            ['', 'Any available'],
            ['env_work', 'alien01 / claude-code / work'],
            ['env_personal', 'alien01 / claude-code / personal']
        ]);
        select().value = 'env_personal';
        select().dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => dom.querySelector('[data-save-card]') !== null, 'the save card');
        dom.querySelector<HTMLFormElement>('form[data-form="agent"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const agent = h.app.as(owner).actor(AgentActor, agentKeyOf(USER, agentId));
        await until(async () => (await agent.get()).configVersion === 2, 'v2 saved');
        expect((await agent.get()).config.execution.defaultEnvironmentId).toBe('env_personal');
    });
});

describe('the machine view model', () => {
    const base: MachineView = {
        key: `${WS}:machine:m1`,
        workspaceId: WS,
        machineId: 'm1' as MachineId,
        name: 'alien01',
        os: 'windows',
        paired: true,
        pairedAt: Date.parse('2026-09-16T10:00:00Z'),
        revoked: false,
        online: true,
        lastSeen: Date.parse('2026-09-17T14:19:56Z'),
        daemonVersion: '0.1.0',
        capabilities: [],
        environments: [env('m1' as MachineId, 'm1:work', 'work', 'ok')],
        activeSessions: [{ sessionId: 's1' as never, environmentId: 'm1:work' as EnvironmentId, agentId: 'forge', taskId: 't1' as never, spec: {} as never, status: 'open', requestedAt: 0, openedAt: Date.parse('2026-09-17T14:10:00Z') }],
        queued: [],
        pending: [],
        closures: [],
        rejected: 0
    };
    const now = Date.parse('2026-09-17T14:20:00Z');

    it('folds Machine.get into the row the group renders', () => {
        expect(machineOf(base, 'index-name', now)).toEqual({ id: 'm1', name: 'alien01', os: 'windows', osLabel: 'Windows', daemonVersion: '0.1.0', online: true, lastSeenAt: base.lastSeen, seen: '4s ago', pairedOn: '16 Sep' });
        // Before the daemon's first hello the index name stands in; a revoked machine is never online.
        expect(machineOf({ ...base, name: '', os: undefined, daemonVersion: undefined, lastSeen: undefined, revoked: true }, 'index-name', now)).toMatchObject({ name: 'index-name', osLabel: 'unknown OS', daemonVersion: '—', online: false, seen: 'never' });
        expect(seenLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
        expect(seenLabel(now - 3 * 86_400_000, now)).toBe('3d ago');
    });

    it('rows the hosted sessions with their objective and environment name', () => {
        expect(sessionsOf(base, { t1: 'Fix the drawer' }, now)).toEqual([{ id: 's1', task: 'Fix the drawer', agentId: 'forge', environment: 'work', machineId: 'm1', status: 'active', age: '10m ago' }]);
        expect(sessionsOf({ ...base, activeSessions: [{ ...base.activeSessions[0]!, status: 'opening' }] }, {}, now)).toMatchObject([{ task: 't1', status: 'waiting' }]);
    });

    it('turns Machine.doctor into the checklist, never passing an unverified environment', () => {
        const doctor: MachineDoctorView = {
            machineId: 'm1' as MachineId,
            online: true,
            ok: false,
            unverified: ['m1:work' as EnvironmentId],
            environments: [{ environmentId: 'm1:work' as EnvironmentId, name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, isolation: 'none' }]
        };
        expect(doctorChecksOf(doctor)).toEqual([
            { text: 'Each environment has its own profile directory', ok: false, note: '0 of 1' },
            { text: 'work can authenticate', ok: true, note: 'ok' },
            { text: "work passed the daemon's doctor", ok: false, note: 'not checked' }
        ]);
        expect(doctorChecksOf({ ...doctor, environments: [], unverified: [] })).toEqual([{ text: 'The daemon has reported no environment', ok: false, note: 'environments.json is empty' }]);
    });

    it('counts the router’s parked tasks per environment and reads the directory for "Default for"', () => {
        const routing = { key: 'r', reports: {}, routes: [
            { taskId: 'a', status: 'waiting-offline', environmentId: 'm1:work', machineId: 'm1' },
            { taskId: 'b', status: 'waiting-offline', environmentId: 'm1:work' },
            { taskId: 'c', status: 'running', environmentId: 'm1:work', machineId: 'm1' },
            { taskId: 'd', status: 'waiting-offline', environmentId: 'm2:work', machineId: 'm2' }
        ] } as never;
        expect(queuedByEnvironment(routing, 'm1')).toEqual({ 'm1:work': 2 });
        expect(queuedByEnvironment(undefined, 'm1')).toEqual({});
        const agents = [
            { id: 'forge', name: 'Forge', role: '', hue: 2 as const, configVersion: 1, environment: { machine: 'm1:work', runtime: 'claude-code', account: 'machine' } },
            { id: 'atlas', name: 'Atlas', role: '', hue: 1 as const, configVersion: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' } },
            { id: 'new', name: 'New', role: '', hue: 3 as const, configVersion: 1, environment: { machine: 'unassigned', runtime: 'claude-code', account: 'machine' } }
        ];
        expect(defaultForByEnvironment(agents)).toEqual({ 'm1:work': [{ name: 'Forge', hue: 2 }] });
        expect(environmentOptions([{ name: 'alien01', environments: base.environments }])).toEqual([{ value: 'm1:work', label: 'alien01 / claude-code / work' }]);
    });

    it('spells the pairing commands and the code’s remaining seconds', () => {
        expect(pairCommands('https://agentic.example', 'K7Q2MX', 'laptop')).toEqual({
            install: 'powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://agentic.example -Code K7Q2MX -Name laptop',
            pair: 'agentic-daemon pair K7Q2MX --url https://agentic.example --name laptop'
        });
        expect(pairCommands('', 'K7Q2MX', 'laptop').pair).toContain('--url "<platform url>"');
        expect(secondsLeft(now + 90_500, now)).toBe(91);
        expect(secondsLeft(now - 1, now)).toBe(0);
    });
});
