import { actorKey, type EnvironmentId, type MachineId, type Principal, type WorkspaceId } from '@agentic/core';
import { workspaceKey } from '../src/auth/index';
import { Chat, ChatPage } from '../src/chat/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';
import { PairingDirectory } from '../src/pairing/index';
import { DEFAULT_SETTINGS, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, RECENT_WORKDIRS_MAX, Workspace, type WorkspaceState } from '../src/workspace/index';

const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');

let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage]);
    return app.start();
});
afterEach(async () => {
    vi.useRealTimers();
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const workspaceSaves = () => app.saves.filter((s) => s.type === 'Workspace');

describe('Workspace authorization', () => {
    const stranger = userPrincipal('u2');
    const agentOfWs: Principal = { kind: 'agent', workspaceId: 'u1' as WorkspaceId, agentId: 'agent_1' as never, sessionId: 'session_1' as never };
    const machineOfWs: Principal = { kind: 'machine', workspaceId: 'u1' as WorkspaceId, machineId: 'machine_1' as never };

    it('admits the owner', async () => {
        const view = await ws().get();
        expect(view.owner).toBe('u1');
        expect(view.settings).toEqual(DEFAULT_SETTINGS);
    });

    it('rejects a second principal on every method', async () => {
        const calls = (p: Principal) => {
            const c = app.as(p).actor(Workspace, KEY);
            return [
                c.get(),
                c.createAgent({ name: 'Ada' }),
                c.createChat({}),
                c.registerMachinePending({ name: 'laptop' }),
                c.claimPairing('ABCDEF'),
                c.listMachines(),
                c.removeMachine('machine_x' as MachineId),
                c.updateSettings({ timeZone: 'Europe/Stockholm' }),
                c.exportAll(),
                c.deleteAll()
            ];
        };
        for (const promise of calls(stranger)) expect(await statusOf(promise)).toBe(403);
        // Same workspace, wrong kind: the root is the owner's alone.
        for (const promise of calls(agentOfWs)) expect(await statusOf(promise)).toBe(403);
        for (const promise of calls(machineOfWs)) expect(await statusOf(promise)).toBe(403);
        // Nothing leaked into the state.
        expect((await ws().get()).agents).toEqual([]);
    });

    it('rejects an anonymous caller with 401', async () => {
        expect(await statusOf(app.as(null).actor(Workspace, KEY).get())).toBe(401);
    });
});

describe('Workspace index', () => {
    it('round-trips agents and chats through storage', async () => {
        const { agentId } = await ws().createAgent({ name: 'Ada' });
        const { chatId } = await ws().createChat({ title: 'general' });
        expect(agentId).toMatch(/^agent_[0-9A-Za-z]+$/);
        expect(chatId).toMatch(/^chat_[0-9A-Za-z]+$/);

        const stored = (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
        expect(stored.agents).toEqual([agentId]);
        expect(stored.chats).toEqual([chatId]);
        // The title went to the Chat actor as its first entry (#124).
        expect((await app.as(owner).actor(Chat, actorKey('u1' as WorkspaceId, 'chat', chatId)).get()).title).toBe('general');

        // A fresh host over the same storage activates from what was saved.
        const storage = app.storage;
        await app.stop();
        app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage], { storage });
        await app.start();
        const view = await ws().get();
        expect(view.agents).toEqual([agentId]);
        expect(view.chats).toEqual([chatId]);
        expect(view.owner).toBe('u1');
    });

    it('createChat without a title, or with a blank one, leaves the chat untitled (#124)', async () => {
        const { chatId } = await ws().createChat({});
        const blank = await ws().createChat({ title: '   ' });
        const chat = (id: string) => app.as(owner).actor(Chat, actorKey('u1' as WorkspaceId, 'chat', id));
        expect((await chat(chatId).get()).title).toBeUndefined();
        expect((await chat(blank.chatId).get()).seq).toBe(0);
        expect((await ws().get()).chats).toEqual([chatId, blank.chatId]);
    });

    it('refuses a nameless agent without saving', async () => {
        await expect(ws().createAgent({ name: '  ' })).rejects.toThrow(/name is required/);
        expect(workspaceSaves()).toHaveLength(0);
    });

    it('saves exactly once per createAgent', async () => {
        const before = (await app.storage.load('Workspace', KEY))?.state;
        expect(before).toBeUndefined(); // nothing written by a read
        expect(workspaceSaves()).toHaveLength(0);

        await ws().createAgent({ name: 'Ada' });

        expect(workspaceSaves()).toEqual([{ type: 'Workspace', key: KEY }]);
        const after = (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
        expect(after.agents).toHaveLength(1);
    });

    it('updates settings one level deep and persists them', async () => {
        const settings = await ws().updateSettings({ timeZone: 'Europe/Stockholm', notifications: { push: true } });
        expect(settings).toEqual({ ...DEFAULT_SETTINGS, timeZone: 'Europe/Stockholm', notifications: { inbox: true, push: true } });
        const stored = (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
        expect(stored.settings).toEqual(settings);
    });

    it('starts the export and delete tasks (v1 stubs)', async () => {
        await expect(ws().exportAll()).resolves.toEqual({ started: true });
        await expect(ws().deleteAll()).resolves.toEqual({ started: true });
    });
});

describe('Workspace machines', () => {
    it('registers a pending machine with a single-use pairing code', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-17T10:00:00Z') });
        const { machineId, pairingCode, expiresAt } = await ws().registerMachinePending({ name: 'laptop' });
        expect(pairingCode).toMatch(new RegExp(`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{${PAIRING_CODE_LENGTH}}$`));
        expect(expiresAt).toBe(Date.now() + PAIRING_CODE_TTL_MS);

        // The list never shows the code again.
        expect(await ws().listMachines()).toEqual([{ id: machineId, name: 'laptop', status: 'pending', registeredAt: Date.now() }]);

        expect(await ws().claimPairing('WRONG1')).toBeNull();
        expect(await ws().claimPairing(pairingCode)).toEqual({ machineId });
        expect(await ws().claimPairing(pairingCode)).toBeNull(); // single use
        expect(await ws().listMachines()).toEqual([{ id: machineId, name: 'laptop', status: 'paired', registeredAt: Date.now(), pairedAt: Date.now() }]);
    });

    it('expires a pairing code after its ttl and drops the pending entry', async () => {
        vi.useFakeTimers({ now: new Date('2026-09-17T10:00:00Z') });
        const { pairingCode } = await ws().registerMachinePending({ name: 'laptop' });
        vi.setSystemTime(Date.now() + PAIRING_CODE_TTL_MS);
        expect(await ws().claimPairing(pairingCode)).toBeNull();
        expect(await ws().listMachines()).toEqual([]);
    });

    it('removes a machine and reports whether it existed', async () => {
        const { machineId } = await ws().registerMachinePending({ name: 'laptop' });
        expect(await ws().removeMachine(machineId)).toBe(true);
        expect(await ws().removeMachine(machineId)).toBe(false);
        expect(await ws().listMachines()).toEqual([]);
        const stored = (await app.storage.load('Workspace', KEY))!.state as WorkspaceState;
        expect(stored.machines).toEqual([]);
    });
});

describe('Workspace recent folders (#190)', () => {
    const ref = (n: number, environmentId = 'env_1') => ({ environmentId: environmentId as EnvironmentId, path: `/work/repo-${n}` });

    it('keeps the newest RECENT_WORKDIRS_MAX, one per environment and path, most recent first', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        expect(await ws().recentWorkdirs()).toEqual([]);
        for (let n = 0; n < RECENT_WORKDIRS_MAX + 5; n++) {
            vi.setSystemTime(1_000 + n);
            await ws().noteWorkdir(ref(n));
        }
        let recents = await ws().recentWorkdirs();
        expect(recents).toHaveLength(RECENT_WORKDIRS_MAX);
        expect(recents[0]).toEqual({ ...ref(RECENT_WORKDIRS_MAX + 4), at: 1_000 + RECENT_WORKDIRS_MAX + 4 });
        expect(recents.at(-1)!.path).toBe('/work/repo-5');

        // Noting one again moves it to the front instead of adding a second row; the same path elsewhere is its own row.
        vi.setSystemTime(5_000);
        await ws().noteWorkdir(ref(10));
        await ws().noteWorkdir(ref(10, 'env_2'));
        await ws().noteWorkdir({ environmentId: 'env_2' as EnvironmentId, path: ' /work/repo-10 ' });
        recents = await ws().recentWorkdirs();
        expect(recents).toHaveLength(RECENT_WORKDIRS_MAX);
        expect(recents.slice(0, 2)).toEqual([{ ...ref(10, 'env_2'), at: 5_000 }, { ...ref(10), at: 5_000 }]);
        expect(recents.filter((r) => r.path === '/work/repo-10' && r.environmentId === 'env_1')).toHaveLength(1);
        expect((await ws().get()).recentWorkdirs).toEqual(recents);
    });

    it('refuses a folder without an environment or a path, and is the owner’s alone', async () => {
        expect(await statusOf(ws().noteWorkdir({ environmentId: 'env_1' as EnvironmentId, path: ' ' }))).toBe(400);
        expect(await statusOf(ws().noteWorkdir({ path: '/work' } as never))).toBe(400);
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Workspace, KEY).noteWorkdir(ref(1)))).toBe(403);
        expect(await ws().recentWorkdirs()).toEqual([]);
    });
});
