/**
 * A project manager's project on the Agents pages (#842): `pmProjectsOf`
 * maps each project's `pm.agentId` to its project; the roster card shows the
 * chip (text, the card is the link) and the agent header links it to
 * Settings › Project manager — on mock data (docs-site, managed by Scout)
 * and live (a project created through `Workspace.upsertProject`, which
 * gives it a manager agent by default).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type ProjectId, type ProjectRecord } from '@agentic/core';
import { Workspace, workspaceKey } from '@agentic/platform';
import { Agents } from '../../src/pages/Agents';
import { Agent } from '../../src/pages/Agent';
import { mockPmProjects, pmProjectsOf } from '../../src/pages/agent/pm';
import { mountAt, text } from '../pages/helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const project = (id: string, name: string, pmAgent?: string): ProjectRecord => ({
    id: id as ProjectId,
    name,
    members: { agentIds: [], coordinator: null },
    folders: {},
    connectors: [],
    features: {},
    createdAt: 0,
    updatedAt: 0,
    ...(pmAgent ? { pm: { agentId: pmAgent as AgentId, policy: PM_POLICY_DEFAULT } } : {})
});

describe('pmProjectsOf', () => {
    it('maps each manager agent to its project, skipping projects without one and keeping the first of several', () => {
        const map = pmProjectsOf([project('p1', 'one', 'a_pm'), project('p2', 'two'), project('p3', 'three', 'a_pm'), project('p4', 'four', 'a_other')]);
        expect([...map.entries()]).toEqual([['a_pm', { id: 'p1', name: 'one' }], ['a_other', { id: 'p4', name: 'four' }]]);
    });

    it('names docs-site as Scout’s project on mock data', () => {
        expect(mockPmProjects().get('a1')).toEqual({ id: 'p_docs', name: 'docs-site' });
        expect(mockPmProjects().has('a2')).toBe(false);
    });
});

describe('the PM chip on mock data', () => {
    it('shows on the manager’s roster card only, as text inside the card link', async () => {
        const root = await mountAt('/agents', <Agents />);
        const chip = root.querySelector('[data-agent-card="a1"] [data-agent-pm]')!;
        expect(chip.getAttribute('data-agent-pm')).toBe('p_docs');
        expect(text(chip)).toBe('PM · docs-site');
        expect(chip.querySelector('a')).toBeNull();
        expect(root.querySelectorAll('[data-agent-pm]')).toHaveLength(1);
    });

    it('links the agent header chip to Settings › Project manager', async () => {
        const root = await mountAt('/agents/a1', <Agent />);
        const link = root.querySelector('[data-agent-header] [data-agent-pm] a')!;
        expect(link.getAttribute('href')).toBe('/projects/p_docs/settings/manager');
        expect(text(link)).toBe('PM · docs-site');
        const other = await mountAt('/agents/a2', <Agent />);
        expect(other.querySelector('[data-agent-pm]')).toBeNull();
    });
});

describe('the PM chip live', () => {
    let h: LiveHarness | undefined;
    afterEach(async () => {
        await h?.stop();
        h = undefined;
    });

    it('marks the project’s manager on the roster and on its page, not a general agent', async () => {
        h = await startLive();
        const forge = await h.agent('Forge', 'Developer');
        const saved = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).upsertProject({ name: 'agentic' });
        const pm = saved.pm!.agentId!;

        const roster = await mountLive('/agents', h);
        await until(() => roster.querySelector(`[data-agent-card="${pm}"] [data-agent-pm]`) !== null, 'the PM chip on the roster');
        expect(roster.querySelector(`[data-agent-card="${pm}"] [data-agent-pm]`)!.getAttribute('data-agent-pm')).toBe(saved.id);
        expect(text(roster.querySelector(`[data-agent-card="${pm}"] [data-agent-pm]`))).toBe('PM · agentic');
        expect(roster.querySelector(`[data-agent-card="${forge}"] [data-agent-pm]`)).toBeNull();

        const page = await mountLive(`/agents/${pm}`, h);
        await until(() => page.querySelector('[data-agent-header] [data-agent-pm] a') !== null, 'the PM chip in the header');
        expect(page.querySelector('[data-agent-header] [data-agent-pm] a')!.getAttribute('href')).toBe(`/projects/${saved.id}/settings/manager`);
    });
});
