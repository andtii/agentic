/**
 * The project manager agent (#784; PRJ-14): every project gets its own manager, created with the project through
 * the Agent create path — the playbook, the personality and the skills; re-running updates it, never duplicates it;
 * changing the personality writes a new config version (AGT-06); a manager never coordinates a second project.
 */
import { PLAN_TOOLS, PM_PERSONALITIES, PM_POLICY_DEFAULT, REQUEST_TOOLS, type AgentId, type ProjectId, type ProjectRecord, type WorkspaceId } from '@agentic/core';
import { AgentActor, agentKey } from '../../src/agent/index';
import { AuditActor, auditKey } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';
import { DEFAULT_PM_SPEC, PM_PLAYBOOK, PM_ROLE, pmCoordinatorError, projectManagerConfig, suggestPmName } from '../../src/workspace/project-manager';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEY = workspaceKey('u1');
const coach = PM_PERSONALITIES.find((p) => p.id === 'friendly-coach')!;

let app: TestActorApp;
beforeEach(async () => {
    app = testActorApp([Workspace, AgentActor, AuditActor]);
    await app.start();
});
afterEach(async () => {
    await app.stop();
});

const ws = () => app.as(owner).actor(Workspace, KEY);
const agent = (id: AgentId) => app.as(owner).actor(AgentActor, agentKey(WS, id));

describe('projectManagerConfig (#784)', () => {
    const project: Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'> = {
        id: 'project_1' as ProjectId,
        name: 'SignalX',
        members: { agentIds: ['agent_a' as AgentId, 'agent_pm' as AgentId], coordinator: 'agent_pm' as AgentId },
        pm: { agentId: 'agent_pm' as AgentId, policy: PM_POLICY_DEFAULT }
    };

    it('builds the playbook then the personality, the skills, the plan and requests tools, the platform runtime and the members', () => {
        const config = projectManagerConfig(project, { name: ' Nova ', personality: { preset: coach.id }, skills: [{ id: 'triage' }, { id: 'triage' }] });
        expect(config).toMatchObject({ name: 'Nova', role: PM_ROLE, skills: [{ id: 'triage' }], execution: { runtime: 'anthropic-api' }, collaborators: ['agent_a'] });
        expect(config.instructions.startsWith(PM_PLAYBOOK)).toBe(true);
        expect(config.instructions.endsWith(coach.instructions)).toBe(true);
        expect(config.tools.map((t) => t.name)).toEqual([...PLAN_TOOLS, ...REQUEST_TOOLS]);
        expect(config.tools.map((t) => t.name)).toContain('projects_request');
    });

    it('suggests a stable name when none is given, and takes custom personality text', () => {
        const config = projectManagerConfig(project, { personality: { custom: '  Terse and exact.  ' }, skills: [] });
        expect(config.name).toBe(suggestPmName(project.id));
        expect(config.instructions.endsWith('\n\nTerse and exact.')).toBe(true);
    });

    it('refuses an unknown preset, an empty custom text and a skill without an id', () => {
        expect(() => projectManagerConfig(project, { personality: { preset: 'nope' }, skills: [] })).toThrow(/no personality preset nope/);
        expect(() => projectManagerConfig(project, { personality: { custom: '  ' }, skills: [] })).toThrow(/custom personality is empty/);
        expect(() => projectManagerConfig(project, { personality: { preset: coach.id }, skills: [{ id: '' }] })).toThrow(/every skill needs an id/);
    });
});

describe('Workspace project manager (#784)', () => {
    it('creating a project creates exactly one manager agent with the playbook, the personality and the skills', async () => {
        const { agentId: forge } = await ws().createAgent({ name: 'Forge' });
        const p = await ws().upsertProject({ name: 'SignalX', members: { agentIds: [forge], coordinator: null }, pm: { name: 'Nova', personality: { preset: coach.id }, skills: [{ id: 'triage' }] } });
        const pm = p.pm!.agentId!;
        expect(p.pm).toEqual({ agentId: pm, policy: PM_POLICY_DEFAULT });
        expect(p.members).toMatchObject({ agentIds: [forge, pm], coordinator: pm });
        expect((await ws().get()).agents).toEqual([forge, pm]);

        const view = await agent(pm).get();
        expect(view.configVersion).toBe(1);
        expect(view.config).toMatchObject({ name: 'Nova', role: PM_ROLE, skills: [{ id: 'triage' }], execution: { runtime: 'anthropic-api' }, collaborators: [forge] });
        expect(view.config.instructions).toContain(PM_PLAYBOOK);
        expect(view.config.instructions).toContain(coach.instructions);
        const audited = await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['config.versioned'] });
        expect(audited.events.map((e) => e.agentId)).toEqual([pm]);
    });

    it('a project with no pm gets one from the default preset; pm: null or a named coordinator opts out', async () => {
        const p = await ws().upsertProject({ name: 'Default' });
        const view = await agent(p.pm!.agentId!).get();
        expect(view.config.instructions).toContain(PM_PERSONALITIES.find((x) => x.id === (DEFAULT_PM_SPEC.personality as { preset: string }).preset)!.instructions);
        expect(view.config.name).toBe(suggestPmName(p.id));

        const none = await ws().upsertProject({ name: 'None', pm: null });
        expect(none.pm).toBeUndefined();
        const { agentId: ada } = await ws().createAgent({ name: 'Ada' });
        const own = await ws().upsertProject({ name: 'Own', members: { agentIds: [ada], coordinator: ada } });
        expect(own.pm).toBeUndefined();
        expect(own.members.coordinator).toBe(ada);
        expect((await ws().get()).agents).toHaveLength(2);
    });

    it('re-running does not duplicate it: createProjectManager updates the same agent', async () => {
        const p = await ws().upsertProject({ name: 'SignalX', pm: { name: 'Nova', personality: { preset: coach.id }, skills: [] } });
        const pm = p.pm!.agentId!;
        const again = await ws().createProjectManager(p.id, { name: 'Nova', personality: { custom: 'Dry humour.' }, skills: [{ id: 'review' }] });
        expect(again.pm!.agentId).toBe(pm);
        expect(again.members.agentIds).toEqual([pm]);
        expect((await ws().get()).agents).toEqual([pm]);
        const view = await agent(pm).get();
        expect(view.configVersion).toBe(2);
        expect(view.config).toMatchObject({ skills: [{ id: 'review' }] });
        expect(view.config.instructions.endsWith('Dry humour.')).toBe(true);
    });

    it('createProjectManager gives an opted-out project its manager once', async () => {
        const p = await ws().upsertProject({ name: 'Later', pm: null });
        const first = await ws().createProjectManager(p.id, { personality: { preset: coach.id }, skills: [] });
        const second = await ws().createProjectManager(p.id, { personality: { preset: coach.id }, skills: [] });
        expect(second.pm!.agentId).toBe(first.pm!.agentId);
        expect(second.members.coordinator).toBe(first.pm!.agentId);
        expect((await ws().get()).agents).toHaveLength(1);
        expect(await statusOf(ws().createProjectManager('project_nope' as ProjectId, DEFAULT_PM_SPEC))).toBe(404);
        expect(await statusOf(ws().createProjectManager(p.id, { personality: { preset: 'nope' }, skills: [] }))).toBe(400);
    });

    it('changing the personality writes a new config version; name and skills change alone', async () => {
        const p = await ws().upsertProject({ name: 'SignalX', pm: { name: 'Nova', personality: { preset: coach.id }, skills: [{ id: 'triage' }] } });
        const pm = p.pm!.agentId!;
        const info = await ws().updateProjectManager(p.id, { personality: { custom: 'Blunt, kind, brief.' } });
        expect(info.version).toBe(2);
        const view = await agent(pm).get();
        expect(view.config.instructions.startsWith(PM_PLAYBOOK)).toBe(true);
        expect(view.config.instructions.endsWith('Blunt, kind, brief.')).toBe(true);
        expect(view.config).toMatchObject({ name: 'Nova', skills: [{ id: 'triage' }] });

        await ws().updateProjectManager(p.id, { name: 'Vega', skills: [] });
        expect((await agent(pm).get()).config).toMatchObject({ name: 'Vega', skills: [], instructions: view.config.instructions });
        expect((await agent(pm).listVersions()).map((v) => v.version)).toEqual([1, 2, 3]);

        expect(await statusOf(ws().updateProjectManager(p.id, {}))).toBe(400);
        expect(await statusOf(ws().updateProjectManager(p.id, { name: '  ' }))).toBe(400);
        const none = await ws().upsertProject({ name: 'None', pm: null });
        expect(await statusOf(ws().updateProjectManager(none.id, { name: 'X' }))).toBe(400);
        expect(await statusOf(ws().updateProjectManager('project_nope' as ProjectId, { name: 'X' }))).toBe(404);
    });

    it('a manager cannot be the coordinator of a second project', async () => {
        const a = await ws().upsertProject({ name: 'SignalX' });
        const pm = a.pm!.agentId!;
        const call = () => ws().upsertProject({ name: 'Other', members: { agentIds: [pm], coordinator: pm } });
        expect(await statusOf(call())).toBe(400);
        await expect(call()).rejects.toThrow(/is the project manager of SignalX; a project manager manages one project/);
        const b = await ws().upsertProject({ name: 'Other', pm: null });
        expect(await statusOf(ws().upsertProject({ id: b.id, members: { agentIds: [pm], coordinator: pm } }))).toBe(400);
        // A plain member elsewhere is fine; its own project may keep it as coordinator.
        expect((await ws().upsertProject({ id: b.id, members: { agentIds: [pm], coordinator: null } })).members.agentIds).toEqual([pm]);
        expect((await ws().upsertProject({ id: a.id, description: 'core' })).members.coordinator).toBe(pm);
        expect(pmCoordinatorError([a], a.id, pm)).toBeUndefined();
    });

    it('pm: null on an existing project unlinks the manager and clears it as coordinator', async () => {
        const p = await ws().upsertProject({ name: 'SignalX' });
        const pm = p.pm!.agentId!;
        const changed = await ws().upsertProject({ id: p.id, pm: null });
        expect(changed.pm).toEqual({ policy: PM_POLICY_DEFAULT });
        expect(changed.members).toMatchObject({ agentIds: [pm], coordinator: null });
    });
});
