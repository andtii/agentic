/**
 * The project Overview (#730) on mock data: ProjectHome for `agentic` (header with feature and connector tags and the
 * `machine → path` line, Your move, five recent chats, Schedules, People and places, Add a feature) and EventHome
 * for a project with no folder; one rail card per enabled feature that registers an `OverviewCard`, none otherwise.
 */
import { describe, it, expect } from 'vitest';
import { component } from 'sigx';
import type { ProjectRecord } from '@agentic/core';
import { MOCK_EVENT_PROJECT, MOCK_PROJECT_OVERVIEW } from '../../src/mock/projects/overview';
import { PROJECTS } from '../../src/mock/workspace';
import { OverviewView } from '../../src/pages/projects/overview/Overview';
import { addFeatureHintOf, featureTagOf, folderLineOf, folderPlacesOf, peopleOf, projectTagsOf, recentChatsOf, type AgentNames } from '../../src/pages/projects/overview/model';
import type { ProjectPage } from '../../src/pages/projects/layout/types';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, page, texts } from '../pages/mount';

const names: AgentNames = (id) => ({ name: id.slice(0, 1).toUpperCase() + id.slice(1) });
const agentic = PROJECTS.find((p) => p.id === 'p_agentic')!;
const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('the Overview model (#730)', () => {
    it('tags a feature by its last id segment and a connector with spaces', () => {
        expect(featureTagOf('agentic.feature.git')).toBe('git');
        expect(projectTagsOf(agentic).map((t) => t.label)).toEqual(['git', 'plan', 'github mcp']);
    });

    it('prints the machine folder before an override, and the no-folder line without one', () => {
        expect(folderPlacesOf(agentic)).toEqual([{ machine: 'alien01', path: 'C:\\Dev\\agentic\\main' }]);
        expect(folderLineOf(agentic)).toBe('alien01 → C:\\Dev\\agentic\\main');
        expect(folderLineOf(MOCK_EVENT_PROJECT)).toBe('no folder · runs on the platform');
        const overrideFirst: Pick<ProjectRecord, 'folders'> = { folders: { 'm1/env_a': 'C:\\a', 'm1/*': 'C:\\shared', env_legacy: '/srv/x' } };
        expect(folderPlacesOf(overrideFirst)).toEqual([{ machine: 'm1', path: 'C:\\shared' }, { machine: 'env_legacy', path: '/srv/x' }]);
    });

    it('lists coordinator, members, folder machines and connectors; suggests features by kind of project', () => {
        expect(peopleOf(agentic, names).map((r) => [r.label, r.value])).toEqual([
            ['Coordinator', 'Atlas'], ['Members', 'Forge, Lint, Atlas'], ['Folder', 'alien01'], ['Connectors', 'github mcp']
        ]);
        expect(peopleOf({ ...MOCK_EVENT_PROJECT, members: { agentIds: [], coordinator: null }, connectors: [] }, names).map((r) => r.value)).toEqual(['none', 'none', 'platform', 'none']);
        expect(addFeatureHintOf(agentic)).toMatch(/^Docs/);
        expect(addFeatureHintOf(MOCK_EVENT_PROJECT)).toMatch(/^Guest list/);
    });

    it('keeps the five most recent chats', () => {
        const chats = recentChatsOf(MOCK_PROJECT_OVERVIEW['p_agentic']!.chats);
        expect(chats).toHaveLength(5);
        expect(chats.map((c) => c.id)).not.toContain('c4');
        expect(chats[0]!.id).toBe('c_rings');
    });
});

describe('the Overview page (#730)', () => {
    it('renders ProjectHome at /projects/p_agentic inside the project layout', async () => {
        const dom = await mountRoute('/projects/p_agentic');
        const el = page(dom, 'project-overview')!;
        expect(el).not.toBeNull();
        expect(el.querySelector('[data-stub]')).toBeNull();
        expect(text(el.querySelector('[data-overview-name]'))).toBe('agentic');
        expect(texts([...el.querySelectorAll('[data-overview-tag]')])).toEqual(['git', 'plan', 'github mcp']);
        expect(text(el.querySelector('[data-overview-folder]'))).toBe('alien01 → C:\\Dev\\agentic\\main');
        expect(texts([...el.querySelectorAll('[data-overview-actions] a')])).toEqual(['New task', 'New chat']);
        expect(el.querySelectorAll('[data-overview-move]')).toHaveLength(3);
        const chats = el.querySelector('[data-overview-card="chats"]')!;
        expect(chats.querySelectorAll('[data-overview-chat]')).toHaveLength(5);
        expect(text(chats.querySelector('[data-overview-card-aside] a'))).toBe('All 6 chats →');
        expect(chats.querySelector('[data-overview-card-aside] a')!.getAttribute('href')).toBe('/projects/p_agentic/chats');
        expect(text(chats.querySelector('[data-overview-chat="c_rel04"] [data-overview-chat-state]'))).toBe('NEEDS YOU');
        // The rail: git's Code card (#746) and Plan's, then the fixed cards and Add a feature.
        const rail = el.querySelector('[data-overview-rail]')!;
        expect([...rail.querySelectorAll('[data-overview-feature]')].map((f) => f.getAttribute('data-overview-feature'))).toEqual(['agentic.feature.git', 'agentic.feature.plan']);
        expect([...rail.children].map((c) => c.getAttribute('data-overview-card') ?? (c.hasAttribute('data-overview-feature') ? 'feature' : c.hasAttribute('data-overview-add-feature') ? 'add' : '?'))).toEqual(['feature', 'feature', 'schedules', 'people', 'add']);
        expect(text(rail.querySelector('[data-overview-schedule]'))).toContain('Nightly dependency check');
        expect(rail.querySelector('[data-overview-add-feature] a')!.getAttribute('href')).toBe('/projects/p_agentic/settings/features');
    });

    it('a project without overview data says nothing needs you and has no chats', async () => {
        const dom = await mountRoute('/projects/p_docs');
        const el = page(dom, 'project-overview')!;
        expect(texts([...el.querySelectorAll('[data-overview-empty]')])).toEqual(['Nothing needs you here.', 'No chats in this project yet.', 'No schedules in this project.']);
    });

    it('renders EventHome: no folder, three feature tags, one rail card per registered OverviewCard', async () => {
        const Card: ProjectPage = component(({ props }) => () => <section data-test-card={props.project.id}>card</section>);
        const views = (id: string) => (id === 'agentic.feature.plan' || id === 'agentic.feature.budget' ? { OverviewCard: Card } : undefined);
        const dom = await mountAt('/projects/p_event', <OverviewView project={MOCK_EVENT_PROJECT} data={MOCK_PROJECT_OVERVIEW['p_event']!} names={names} views={views} />);
        await settle();
        expect(texts([...dom.querySelectorAll('[data-overview-tag="feature"]')])).toEqual(['calendar', 'plan', 'budget']);
        expect(text(dom.querySelector('[data-overview-folder]'))).toBe('no folder · runs on the platform');
        expect(dom.querySelectorAll('[data-overview-move]')).toHaveLength(2);
        expect(dom.querySelectorAll('[data-overview-chat]')).toHaveLength(3);
        const features = [...dom.querySelectorAll('[data-overview-feature]')].map((f) => f.getAttribute('data-overview-feature'));
        expect(features).toEqual(['agentic.feature.plan', 'agentic.feature.budget']);
        expect(dom.querySelectorAll('[data-test-card="p_event"]')).toHaveLength(2);
        expect(text(dom.querySelector('[data-overview-add-feature]'))).toContain('Guest list, travel, docs, and more');
    });
});
