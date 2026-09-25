/**
 * Workspace projects, redesign (#734; PRJ-01/02/14): `upsertProject` validates
 * member `roles` and `limits` (1…`MEMBER_LIMIT_MAX`) and the project `color`,
 * `project.changed` carries the changed keys, and `projectSummaries` counts
 * each project's chats and their newest activity server side.
 */
import { MEMBER_LIMIT_MAX, actorKey, type AgentId, type ChatId, type ProjectId, type WorkspaceId } from '@agentic/core';
import { AuditActor, auditKey } from '../src/audit/index';
import { workspaceKey } from '../src/auth/index';
import { Chat, ChatPage } from '../src/chat/index';
import { PairingDirectory } from '../src/pairing/index';
import { defineRegistry } from '../src/registry/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';
import { MAX_PROJECT_ROLE_LENGTH, Workspace } from '../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');
const Registry = defineRegistry({ catalogue: [] });

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp([Workspace, PairingDirectory, Chat, ChatPage, Registry, AuditActor]);
    await app.start();
});
afterEach(async () => {
    await app.stop();
    vi.restoreAllMocks();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));
const changes = async () => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['project.changed'] })).events.map((e) => (e.data as { changed?: string[] }).changed);
const refused = async (call: () => Promise<unknown>, text: RegExp): Promise<void> => {
    expect(await statusOf(call())).toBe(400);
    await expect(call()).rejects.toThrow(text);
};

async function agents(n: number): Promise<AgentId[]> {
    const ids: AgentId[] = [];
    for (let i = 0; i < n; i++) ids.push((await ws().createAgent({ name: `A${i}` })).agentId);
    return ids;
}

describe('Workspace projects — member roles and limits (#734)', () => {
    it('stores roles as one trimmed line and limits as given, keyed by members only', async () => {
        const [a, b] = await agents(2);
        const p = await ws().upsertProject({ name: 'P', members: { agentIds: [a!, b!], coordinator: a!, roles: { [a!]: '  Lead\n  developer ', [b!]: '   ' }, limits: { [a!]: 3, [b!]: MEMBER_LIMIT_MAX } } });
        expect(p.members).toEqual({ agentIds: [a, b], coordinator: a, roles: { [a!]: 'Lead developer' }, limits: { [a!]: 3, [b!]: MEMBER_LIMIT_MAX } });
        expect((await ws().projects())[0]!.members).toEqual(p.members);
    });

    it('refuses roles or limits for non-members, a bad limit, and a role that is too long or not text', async () => {
        const [a, b] = await agents(2);
        const members = (extra: object) => ({ members: { agentIds: [a!], coordinator: null, ...extra } });
        await refused(() => ws().upsertProject({ name: 'P', ...members({ roles: { [b!]: 'Reviewer' } }) }), /roles: .* is not a member/);
        await refused(() => ws().upsertProject({ name: 'P', ...members({ limits: { [b!]: 2 } }) }), /limits: .* is not a member/);
        for (const limit of [0, MEMBER_LIMIT_MAX + 1, 1.5, '2']) await refused(() => ws().upsertProject({ name: 'P', ...members({ limits: { [a!]: limit } }) }), /whole number from 1 to 10/);
        await refused(() => ws().upsertProject({ name: 'P', ...members({ roles: { [a!]: 'x'.repeat(MAX_PROJECT_ROLE_LENGTH + 1) } }) }), /longer than 40/);
        await refused(() => ws().upsertProject({ name: 'P', ...members({ roles: { [a!]: 7 } }) }), /must be text/);
        await refused(() => ws().upsertProject({ name: 'P', ...members({ roles: ['Dev'] }) }), /roles must be an object/);
        expect(await ws().projects()).toEqual([]);
    });

    it('keeps roles and limits a members patch leaves out, for the agents still members', async () => {
        const [a, b] = await agents(2);
        const p = await ws().upsertProject({ name: 'P', members: { agentIds: [a!, b!], coordinator: null, roles: { [a!]: 'Dev', [b!]: 'Reviewer' }, limits: { [b!]: 4 } } });
        const kept = await ws().upsertProject({ id: p.id, members: { agentIds: [a!], coordinator: a! } });
        expect(kept.members).toEqual({ agentIds: [a], coordinator: a, roles: { [a!]: 'Dev' } });
        const cleared = await ws().upsertProject({ id: p.id, members: { agentIds: [a!], coordinator: a!, roles: {} } });
        expect(cleared.members).toEqual({ agentIds: [a], coordinator: a });
    });
});

describe('Workspace projects — colour (#734)', () => {
    it('sets, keeps, refuses and clears the colour', async () => {
        const p = await ws().upsertProject({ name: 'P', color: 'orange' });
        expect(p.color).toBe('orange');
        expect((await ws().upsertProject({ id: p.id, name: 'Q' })).color).toBe('orange');
        await refused(() => ws().upsertProject({ id: p.id, color: 'green' as never }), /colour must be one of violet, orange, pink, blue/);
        const cleared = await ws().upsertProject({ id: p.id, color: null });
        expect(cleared).not.toHaveProperty('color');
    });
});

describe('Workspace projects — audit changed keys (#734)', () => {
    it('project.changed names the keys that changed', async () => {
        // The audit key carries the millisecond: keep every upsert on its own.
        let clock = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
        const [a] = await agents(1);
        const p = await ws().upsertProject({ name: 'P', color: 'blue' });
        await ws().upsertProject({ id: p.id, color: 'pink', members: { agentIds: [a!], coordinator: null, limits: { [a!]: 2 } } });
        await ws().upsertProject({ id: p.id, name: 'P' });
        // Newest first.
        expect(await changes()).toEqual([[], ['members', 'color'], ['name', 'members', 'folders', 'connectors', 'features', 'color']]);
    });
});

describe('Workspace.projectSummaries (#734)', () => {
    it('counts each project’s chats and their newest activity, the rest as unassigned', async () => {
        const p1 = await ws().upsertProject({ name: 'One' });
        const p2 = await ws().upsertProject({ name: 'Two' });
        const gone = await ws().upsertProject({ name: 'Gone' });
        const { chatId: c1 } = await ws().createChat({ projectId: p1.id });
        const { chatId: c2 } = await ws().createChat({ projectId: p1.id });
        const { chatId: c3 } = await ws().createChat({ projectId: gone.id });
        await ws().createChat();
        await ws().removeProject(gone.id);
        await chat(c1).post('hello');
        await chat(c2).post('later');
        await chat(c3).post('orphan');
        const newestAt = async (id: ChatId) => (await chat(id).history(null, 1)).entries.at(-1)!.entry.at;

        const summaries = await ws().projectSummaries();
        expect(summaries.projects.map((s) => s.projectId)).toEqual([p1.id, p2.id]);
        expect(summaries.projects[0]).toEqual({ projectId: p1.id, openChats: 2, archivedChats: 0, lastActivityAt: Math.max(await newestAt(c1), await newestAt(c2)) });
        expect(summaries.projects[1]).toEqual({ projectId: p2.id as ProjectId, openChats: 0, archivedChats: 0 });
        expect(summaries.unassigned).toEqual({ openChats: 2, lastActivityAt: await newestAt(c3) });
    });

    it('answers for a workspace with no projects or chats', async () => {
        expect(await ws().projectSummaries()).toEqual({ projects: [], unassigned: { openChats: 0 } });
    });
});
