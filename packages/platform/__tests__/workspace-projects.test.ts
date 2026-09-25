/**
 * Workspace projects (#332; AGT-05, COL-04): `upsertProject` / `removeProject` /
 * `projects` / `noteProject` round-trip with one save each; a folder is
 * checked against its environment's roots through the paired machines'
 * reports (an environment nobody reports is refused); members must be agents
 * of the workspace; feature settings go through the Registry; the
 * `PROJECTS_MAX + 1`th project is refused; `createChat({ projectId })` puts the
 * chat in the project and notes it as the last used.
 */
import { PROJECTS_MAX, actorKey, projectFolderFor, projectFolderKey, type EnvironmentId, type MachineId, type Principal, type ProjectFeatureManifest, type ProjectId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import { AuditActor, auditKey } from '../src/audit/index';
import { AgentActor } from '../src/agent/index';
import { workspaceKey } from '../src/auth/index';
import { Chat, ChatPage } from '../src/chat/index';
import { defineMachineActor, machineKey, type MachineSocketPort } from '../src/machine/index';
import { PairingDirectory } from '../src/pairing/index';
import { defineRegistry, registryKey } from '../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';
import { MAX_PROJECT_NAME_LENGTH, Workspace, type WorkspaceState } from '../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');
const E1 = 'env_1' as EnvironmentId;
const E2 = 'env_2' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

const git: ProjectFeatureManifest = {
    id: 'agentic.project.git',
    version: '1.0.0',
    kind: 'project-feature',
    name: 'Git',
    description: 'Worktrees per task',
    capabilities: [],
    config: { type: 'object' },
    projectSettings: { type: 'object', properties: { baseBranch: { type: 'string', default: 'main' }, worktrees: { type: 'boolean', default: true } } },
    permissions: [],
    compat: { platform: '*', core: '*' }
};

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

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const Registry = defineRegistry({ catalogue: [git] });
let app: TestActorApp;
let sockets: FakeSockets;
let Machine: ReturnType<typeof defineMachineActor>;
const daemons: InMemoryDaemon[] = [];

beforeEach(async () => {
    sockets = new FakeSockets();
    Machine = defineMachineActor({ socket: sockets });
    app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, Machine, Registry, AuditActor, AgentActor]);
    await app.start();
});
afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));
const workspaceSaves = () => app.saves.filter((s) => s.type === 'Workspace');
const stored = async () => (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
const auditEvents = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['project.changed'] })).events;

/** A paired, online machine reporting E1 (roots `/work`, `/scratch`) and E2 (root `/other`), or the roots given. */
async function onlineMachine(name = 'laptop', roots: Partial<Record<EnvironmentId, string[]>> = { [E1]: ['/work', '/scratch'], [E2]: ['/other'] }): Promise<MachineId> {
    const { machineId, pairingCode } = await ws().registerMachinePending({ name });
    await machine(machineId).pair(pairingCode, { name });
    const environments = Object.entries(roots).map(([id, cwdRoots]) => ({ ...inMemoryEnvironment(machineId, id as EnvironmentId), cwdRoots: cwdRoots! }));
    const d = inMemoryHarness({ machineId, environments }).start({ events: 2, heartbeatMs: 600_000 }) as InMemoryDaemon;
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
    await until(async () => (await machine(machineId).get()).online, 'the machine to come online');
    return machineId;
}

describe('Workspace projects (#332)', () => {
    it('upsert / list / note / remove round-trip with one save each, and the record survives a restart', async () => {
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        const before = workspaceSaves().length;
        const created = await ws().upsertProject({ name: '  Agentic   platform ', description: 'the repo', members: { agentIds: [agentId], coordinator: agentId }, connectors: [{ id: 'github' }, { id: 'github' }] });
        expect(created).toMatchObject({ name: 'Agentic platform', description: 'the repo', members: { agentIds: [agentId], coordinator: agentId }, folders: {}, connectors: [{ id: 'github' }], features: {} });
        expect(created.id).toMatch(/^project_[0-9A-Za-z]+$/);
        expect(created.createdAt).toBe(created.updatedAt);
        expect(workspaceSaves()).toHaveLength(before + 1);
        expect(await ws().projects()).toEqual([created]);

        // A change keeps what the patch leaves out; `null` clears the description.
        const changed = await ws().upsertProject({ id: created.id, description: null, connectors: [] });
        expect(changed).toMatchObject({ id: created.id, name: 'Agentic platform', members: created.members, connectors: [], createdAt: created.createdAt });
        expect('description' in changed).toBe(false);
        expect(workspaceSaves()).toHaveLength(before + 2);

        await ws().noteProject(created.id);
        expect((await ws().get()).lastProjectId).toBe(created.id);
        expect(workspaceSaves()).toHaveLength(before + 3);
        expect((await stored()).projects).toEqual([changed]);
        expect((await auditEvents()).map((e) => (e.data as { op: string }).op)).toEqual(['updated', 'created']);

        const storage = app.storage;
        await app.stop();
        app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, Machine, Registry, AuditActor, AgentActor], { storage });
        await app.start();
        expect(await ws().projects()).toEqual([changed]);
        expect((await ws().get()).lastProjectId).toBe(created.id);

        const saved = workspaceSaves().length;
        await ws().removeProject(created.id);
        expect(await ws().projects()).toEqual([]);
        expect((await ws().get()).lastProjectId).toBeUndefined();
        expect(workspaceSaves()).toHaveLength(saved + 1);
        expect(await statusOf(ws().removeProject(created.id))).toBe(404);
        expect(await statusOf(ws().noteProject(created.id))).toBe(400);
        await ws().noteProject(null);
        expect((await auditEvents())[0]).toMatchObject({ summary: `project Agentic platform (${created.id}) removed`, data: { op: 'removed' } });
    });

    it('refuses a blank or overlong name, an unknown id, a member that is no agent, a coordinator outside the members, and a bad connector (400/404) without saving', async () => {
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        const before = workspaceSaves().length;
        expect(await statusOf(ws().upsertProject({}))).toBe(400);
        expect(await statusOf(ws().upsertProject({ name: '   ' }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ name: 'x'.repeat(MAX_PROJECT_NAME_LENGTH + 1) }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ id: 'project_nope' as ProjectId, name: 'x' }))).toBe(404);
        expect(await statusOf(ws().upsertProject({ name: 'x', members: { agentIds: ['agent_nope' as never], coordinator: null } }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ name: 'x', members: { agentIds: [agentId], coordinator: 'agent_other' as never } }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ name: 'x', connectors: [{} as never] }))).toBe(400);
        expect(workspaceSaves()).toHaveLength(before);
        expect(await ws().projects()).toEqual([]);
    });

    it('a machine folder must be inside the roots of an environment on that machine; null removes one', async () => {
        const m = await onlineMachine();
        const before = workspaceSaves().length;
        expect(await statusOf(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m)]: '/elsewhere/app' } }))).toBe(400);
        await expect(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m)]: '/work2/app' } })).rejects.toThrow(/outside the roots of every environment on machine laptop \(\/work, \/scratch, \/other\)/);
        expect(await statusOf(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m)]: 'work/app' } }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m)]: '  ' } }))).toBe(400);
        // A machine that is not paired to the workspace, and a key of no known shape.
        await expect(ws().upsertProject({ name: 'x', folders: { [projectFolderKey('machine_nope' as MachineId)]: '/work/app' } })).rejects.toThrow(/machine machine_nope is not a paired machine of the workspace/);
        expect(await statusOf(ws().upsertProject({ name: 'x', folders: { 'a/b/c': '/work/app' } }))).toBe(400);
        expect(workspaceSaves()).toHaveLength(before);

        // One folder for the machine serves every environment whose roots hold it (E1 here); E2 can have its own.
        const created = await ws().upsertProject({ name: 'Agentic', folders: { [projectFolderKey(m)]: ' /work/agentic ', [projectFolderKey(m, E2)]: '/other/agentic' } });
        expect(created.folders).toEqual({ [projectFolderKey(m)]: '/work/agentic', [projectFolderKey(m, E2)]: '/other/agentic' });
        const changed = await ws().upsertProject({ id: created.id, folders: { [projectFolderKey(m, E2)]: null } });
        expect(changed.folders).toEqual({ [projectFolderKey(m)]: '/work/agentic' });
        // A bad folder in a patch refuses the whole patch: the kept folder stands.
        expect(await statusOf(ws().upsertProject({ id: created.id, name: 'renamed', folders: { [projectFolderKey(m)]: '/nowhere' } }))).toBe(400);
        expect((await ws().projects())[0]).toMatchObject({ name: 'Agentic', folders: { [projectFolderKey(m)]: '/work/agentic' } });
    });

    it('an environment override must be inside that environment\'s roots on that machine', async () => {
        const m = await onlineMachine();
        await expect(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m, E2)]: '/work/app' } })).rejects.toThrow(/outside the roots of environment env_2 on machine laptop \(\/other\)/);
        await expect(ws().upsertProject({ name: 'x', folders: { [projectFolderKey(m, 'env_nope' as EnvironmentId)]: '/work/app' } })).rejects.toThrow(/machine laptop reports no environment env_nope/);
    });

    it('the same environment id on two machines keeps a folder per machine (#702)', async () => {
        // The daemon names environments `env_<slug>`, so a Mac and a Windows box both carry E1 with their own roots.
        const mac = await onlineMachine('mac', { [E1]: ['/Users/me/dev'] });
        const win = await onlineMachine('win', { [E1]: ['/win/dev'] });
        const created = await ws().upsertProject({ name: 'Agentic', folders: { [projectFolderKey(mac)]: '/Users/me/dev/agentic', [projectFolderKey(win)]: '/win/dev/agentic' } });
        expect(projectFolderFor(created, E1, mac)).toBe('/Users/me/dev/agentic');
        expect(projectFolderFor(created, E1, win)).toBe('/win/dev/agentic');
    });

    it('a pre-#702 folder keyed by a bare environment id is kept, removable, and never written again', async () => {
        const created = await ws().upsertProject({ name: 'Agentic' });
        const record = (await app.storage.load('Workspace', KEY))!;
        const state = record.state as WorkspaceState;
        const legacy = { ...state, projects: (state.projects ?? []).map((p) => (p.id === created.id ? { ...p, folders: { [E1]: '/work/old' } } : p)) };
        const storage = app.storage;
        await app.stop();
        await storage.save('Workspace', KEY, legacy, record.etag);
        app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, Machine, Registry, AuditActor, AgentActor], { storage });
        await app.start();
        const m = await onlineMachine();
        expect((await ws().projects())[0]!.folders).toEqual({ [E1]: '/work/old' });
        await expect(ws().upsertProject({ id: created.id, folders: { [E2]: '/other/agentic' } })).rejects.toThrow(/key folders by machine/);
        const moved = await ws().upsertProject({ id: created.id, folders: { [E1]: null, [projectFolderKey(m)]: '/work/agentic' } });
        expect(moved.folders).toEqual({ [projectFolderKey(m)]: '/work/agentic' });
    });

    it('feature settings are checked by the Registry; null removes the feature', async () => {
        const created = await ws().upsertProject({ name: 'Agentic', features: { 'agentic.project.git': { baseBranch: 'develop' } } });
        expect(created.features).toEqual({ 'agentic.project.git': { baseBranch: 'develop' } });
        await expect(ws().upsertProject({ id: created.id, features: { 'agentic.project.git': { worktrees: 'yes' } } })).rejects.toThrow(/feature agentic.project.git: .*worktrees/);
        expect(await statusOf(ws().upsertProject({ id: created.id, features: { nope: {} } }))).toBe(400);
        expect(await statusOf(ws().upsertProject({ id: created.id, features: { 'agentic.project.git': [] as never } }))).toBe(400);
        await app.as(owner).actor(Registry, registryKey(WS)).disable('agentic.project.git');
        expect(await statusOf(ws().upsertProject({ id: created.id, features: { 'agentic.project.git': {} } }))).toBe(400);
        // Removing needs no plugin check: a feature of a plugin that is off can still be switched off.
        const cleared = await ws().upsertProject({ id: created.id, features: { 'agentic.project.git': null } });
        expect(cleared.features).toEqual({});
    });

    it(`refuses the ${PROJECTS_MAX + 1}th project`, async () => {
        for (let i = 0; i < PROJECTS_MAX; i++) await ws().upsertProject({ name: `p${i}` });
        expect((await ws().projects()).length).toBe(PROJECTS_MAX);
        expect(await statusOf(ws().upsertProject({ name: 'one too many' }))).toBe(400);
        // A change of an existing one is fine at the cap.
        const first = (await ws().projects())[0]!;
        expect((await ws().upsertProject({ id: first.id, name: 'renamed' })).name).toBe('renamed');
    });

    it('createChat({ projectId }) puts the chat in the project over a hop and notes the project as the last used; an unknown project is refused first', async () => {
        const project = await ws().upsertProject({ name: 'Agentic' });
        expect(await statusOf(ws().createChat({ projectId: 'project_nope' as ProjectId }))).toBe(400);
        expect((await ws().get()).chats).toEqual([]);
        const { chatId } = await ws().createChat({ title: 'general', projectId: project.id });
        const chat = app.as(owner).actor(Chat, actorKey(WS, 'chat', chatId));
        expect(await chat.get()).toMatchObject({ title: 'general', projectId: project.id, project: { id: project.id, name: 'Agentic' } });
        expect((await ws().get()).lastProjectId).toBe(project.id);
        expect((await ws().get()).chats).toEqual([chatId]);
        // Removing the project clears the last-used note; the chat keeps its id (decisions 2026-09-20).
        await ws().removeProject(project.id);
        expect((await ws().get()).lastProjectId).toBeUndefined();
        expect((await chat.get()).projectId).toBe(project.id);
    });
});
