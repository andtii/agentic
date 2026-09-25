/**
 * `Workspace.upsertProject` feature needs (#772, PRJ-07): a feature the patch newly enables is checked against the
 * project's folders after the patch, so Git — which needs a folder — is refused on a project without one, in one
 * line, and accepted once the project (or the same patch) gives it a folder. A feature already on is not re-judged.
 */
import { projectFolderKey, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureManifest, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../../src/machine/index';
import { PairingDirectory } from '../../src/pairing/index';
import { defineRegistry } from '../../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

const base = {
    version: '1.0.0',
    kind: 'project-feature',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object' },
    permissions: [],
    compat: { platform: '*', core: '*' }
} as const;

const git: ProjectFeatureManifest = { ...base, id: 'agentic.project.git', name: 'Git', description: 'Worktrees per task', ui: { needs: ['folder'] } };
const plan: ProjectFeatureManifest = { ...base, id: 'agentic.project.plan', name: 'Plan', description: 'Milestones' };

class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
}

const Registry = defineRegistry({ catalogue: [git, plan] });
let app: TestActorApp;
let sockets: FakeSockets;
let Machine: ReturnType<typeof defineMachineActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    sockets = new FakeSockets();
    Machine = defineMachineActor({ socket: sockets });
    app = testActorApp([Workspace, PairingDirectory, Machine, Registry, AuditActor, AgentActor]);
    await app.start();
});
afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, workspaceKey('u1'));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));

/** A paired, online machine reporting E1 with root `/work`. */
async function onlineMachine(): Promise<MachineId> {
    const { machineId, pairingCode } = await ws().registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [{ ...inMemoryEnvironment(machineId, E1), cwdRoots: ['/work'] }] }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(machineId, asMachine(machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    const deadline = Date.now() + 4_000;
    while (!(await machine(machineId).get()).online) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the machine to come online');
        await new Promise((r) => setTimeout(r, 5));
    }
    return machineId;
}

describe('Workspace.upsertProject feature needs (#772)', () => {
    it('refuses Git on a new project without a folder, in one line', async () => {
        const refused = ws().upsertProject({ name: 'x', features: { [git.id]: {} } });
        expect(await statusOf(refused)).toBe(400);
        await expect(ws().upsertProject({ name: 'x', features: { [git.id]: {} } })).rejects.toThrow(/Git needs a folder/);
        expect(await ws().projects()).toEqual([]);
    });

    it('refuses turning Git on for an existing project without a folder', async () => {
        const project = await ws().upsertProject({ name: 'x' });
        await expect(ws().upsertProject({ id: project.id, features: { [git.id]: {} } })).rejects.toThrow(/Git needs a folder/);
        expect((await ws().projects())[0]!.features).toEqual({});
    });

    it('accepts a feature without needs on a project without a folder', async () => {
        const project = await ws().upsertProject({ name: 'x', features: { [plan.id]: {} } });
        expect(project.features).toEqual({ [plan.id]: {} });
    });

    it('accepts Git with a folder in the same patch or already on the project', async () => {
        const m = await onlineMachine();
        const same = await ws().upsertProject({ name: 'a', folders: { [projectFolderKey(m)]: '/work/a' }, features: { [git.id]: {} } });
        expect(same.features).toEqual({ [git.id]: {} });
        const later = await ws().upsertProject({ name: 'b', folders: { [projectFolderKey(m)]: '/work/b' } });
        expect((await ws().upsertProject({ id: later.id, features: { [git.id]: {} } })).features).toEqual({ [git.id]: {} });
    });

    it('refuses Git when the same patch removes the last folder', async () => {
        const m = await onlineMachine();
        const project = await ws().upsertProject({ name: 'a', folders: { [projectFolderKey(m)]: '/work/a' } });
        await expect(ws().upsertProject({ id: project.id, folders: { [projectFolderKey(m)]: null }, features: { [git.id]: {} } })).rejects.toThrow(/Git needs a folder/);
    });

    it('does not re-judge a feature already on when its folder goes', async () => {
        const m = await onlineMachine();
        const project = await ws().upsertProject({ name: 'a', folders: { [projectFolderKey(m)]: '/work/a' }, features: { [git.id]: {} } });
        const changed = await ws().upsertProject({ id: project.id, folders: { [projectFolderKey(m)]: null }, features: { [git.id]: {} } });
        expect(changed).toMatchObject({ folders: {}, features: { [git.id]: {} } });
    });
});
