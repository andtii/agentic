/**
 * The project layout's menu data and picker (#728): the menu's counts (Chats count, Work's needs-you badge, a
 * feature's count) from the sample counts, the sample chats or — live — `Workspace.projectSummaries()`; the project
 * picker's sections, search and keyboard. #728 owns this file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ProjectRecord } from '@agentic/core';
import { clientDefs } from '../../src/actors/client';
import { setDataMode } from '../../src/data-mode';
import { PROJECTS } from '../../src/mock/workspace';
import { countsFor, countsFromChats, projectCounts } from '../../src/pages/projects/layout/counts';
import { projectMenu, projectMenuFor, type ProjectMenuItem } from '../../src/pages/projects/layout/menu';
import { openProjectPicker, pickerMove, pickerSections, projectPicker } from '../../src/pages/projects/layout/ProjectPicker';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { saveProjectWith } from '../../src/pages/projects/live';
import { setText, text } from '../pages/helpers';
import { mountRoute, tick } from '../pages/mount';
import { USER, mountLive, startLive, until } from '../pages/live-harness';

const route = (path: string, id: string) => ({ name: 'project', path, params: { id } });
const item = (items: readonly ProjectMenuItem[], label: string): ProjectMenuItem => items.find((i) => i.label === label)!;
const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await tick(); };

afterEach(() => {
    projectPicker.open = false;
    projectCounts.value = null;
});

describe('menu counts (#728)', () => {
    it('derives a project’s counts from its chats, and prefers the Workspace summary line', () => {
        const chats = [{ projectId: 'p1', waiting: true }, { projectId: 'p1', waiting: false }, { projectId: 'p2', waiting: true }, { waiting: true }];
        expect(countsFromChats('p1', chats)).toEqual({ chats: 2, needsYou: 1 });
        expect(countsFor('p1', [{ projectId: 'p1', openChats: 7 }], chats)).toEqual({ chats: 7 });
        expect(countsFor('p1', [{ projectId: 'p2', openChats: 7 }], chats)).toEqual({ chats: 2, needsYou: 1 });
        expect(countsFor('p1', undefined)).toBeUndefined();
    });

    it('puts the count on Chats, the needs-you badge on Work (its count when nothing waits), and a count on a feature', () => {
        const head = { id: 'p1', name: 'one', manager: true };
        const core = { items: projectMenu(head, { chats: 5, work: 7, needsYou: 3 })[0]!.items as readonly ProjectMenuItem[] };
        expect(item(core.items, 'Chats')).toMatchObject({ count: 5 });
        expect(item(core.items, 'Work')).toMatchObject({ badge: 3 });
        expect(item(core.items, 'Work').count).toBeUndefined();
        expect(item(core.items, 'Overview').count).toBeUndefined();
        expect(item(core.items, 'Requests').badge).toBeUndefined();
        const calm = { items: projectMenu(head, { chats: 0, work: 7 })[0]!.items as readonly ProjectMenuItem[] };
        expect(item(calm.items, 'Work')).toMatchObject({ count: 7 });
        expect(item(calm.items, 'Work').badge).toBeUndefined();
        expect(item(calm.items, 'Chats').count).toBeUndefined();
    });

    it('matches the ProjectHome board in mock mode: Chats 5, Work with 3 that need you; another project counts its sample chats', () => {
        const agentic = projectMenuFor(route('/projects/p_agentic', 'p_agentic'))!;
        const core = agentic[0]!.items as readonly ProjectMenuItem[];
        expect(core.map((i) => [i.label, i.icon])).toEqual([['Overview', 'home'], ['Chats', 'chats'], ['Work', 'check'], ['Requests', 'delegate']]);
        expect(item(core, 'Chats').count).toBe(5);
        expect(item(core, 'Work').badge).toBe(3);
        const docs = projectMenuFor(route('/projects/p_docs', 'p_docs'))!;
        expect(item(docs[0]!.items, 'Chats').count).toBe(1);
        expect(item(docs[0]!.items, 'Work').badge).toBeUndefined();
    });
});

describe('the project picker (#728)', () => {
    const p = (id: string, name: string, description?: string): ProjectRecord => ({ ...PROJECTS[0]!, id: id as ProjectRecord['id'], name, ...(description ? { description } : { description: undefined }) });
    const all = [p('p_a', 'alpha'), p('p_b', 'beta', 'The blog'), p('p_c', 'gamma')];

    it('lists the last-used project under Recent and the rest under All projects; a query matches name, description or id', () => {
        expect(pickerSections(all, 'p_b', '').map((s) => [s.label, s.projects.map((x) => x.id)])).toEqual([['Recent', ['p_b']], ['All projects', ['p_a', 'p_c']]]);
        expect(pickerSections(all, null, '').map((s) => s.label)).toEqual(['All projects']);
        expect(pickerSections(all, 'p_c', ' A ').map((s) => [s.label, s.projects.map((x) => x.id)])).toEqual([['Matches', ['p_c', 'p_a', 'p_b']]]);
        expect(pickerSections(all, null, 'blog')[0]!.projects.map((x) => x.id)).toEqual(['p_b']);
        expect(pickerSections(all, null, 'zzz')).toEqual([]);
    });

    it('moves through the options with the arrow keys, Home and End, wrapping at the ends', () => {
        expect(pickerMove('ArrowDown', 0, 3)).toBe(1);
        expect(pickerMove('ArrowDown', 2, 3)).toBe(0);
        expect(pickerMove('ArrowUp', 0, 3)).toBe(2);
        expect(pickerMove('Home', 2, 3)).toBe(0);
        expect(pickerMove('End', 0, 3)).toBe(2);
        expect(pickerMove('a', 0, 3)).toBeNull();
        expect(pickerMove('ArrowDown', 0, 0)).toBeNull();
    });

    it('opens from the switcher, filters as you type, and Enter on the active option opens that project', async () => {
        const dom = await mountRoute('/projects/p_agentic');
        expect(dom.querySelector('[data-project-layout="p_agentic"]')).not.toBeNull();
        openProjectPicker();
        await settle();
        const input = document.querySelector<HTMLInputElement>('input[name="project-search"]')!;
        expect(input.getAttribute('role')).toBe('combobox');
        const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-project-option]')];
        expect(options().map((o) => o.dataset.projectOption)).toEqual(['p_agentic', 'p_docs']);
        expect(options()[0]!.hasAttribute('data-current')).toBe(true);
        expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await settle();
        expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
        expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
        setText(input, 'nothing-like-it');
        await settle();
        expect(options()).toEqual([]);
        expect(text(document.querySelector('[data-project-picker-empty]'))).toContain('nothing-like-it');
        setText(input, 'docs');
        await settle();
        expect(options().map((o) => o.dataset.projectOption)).toEqual(['p_docs']);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        expect(projectPicker.open).toBe(false);
        expect(dom.querySelector('[data-project-layout="p_docs"]')).not.toBeNull();
    });
});

describe('menu counts on the live wire (#728)', () => {
    it('reads the project’s open chats from Workspace.projectSummaries', { timeout: 20_000 }, async () => {
        const h = await startLive();
        try {
            const forge = await h.agent('Forge', 'Builds things');
            const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: null }, folders: {}, connectors: [], features: {} });
            await createChatWith(clientDefs(), USER, [forge], null, id);
            await mountLive(`/projects/${id}`, h);
            await until(() => projectCounts.value?.id === id && projectCounts.value.counts.chats === 1, 'the summary counts');
            setDataMode('live');
            const menu = projectMenuFor(route(`/projects/${id}`, id))!;
            expect(item(menu[0]!.items, 'Chats').count).toBe(1);
        } finally {
            setDataMode('mock');
            await h.stop();
        }
    });
});
