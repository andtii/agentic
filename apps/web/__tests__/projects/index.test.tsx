/**
 * `/projects` (#729; PRJ-02): the index board on mock data — heading and count, the Projects | Links tabs, the
 * open-links strip, a card per project with what needs you, the unassigned strip — plus the board's loading and
 * empty states and the pure card model. #729 owns this file.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import type { ProjectRecord } from '@agentic/core';
import { topbarFor } from '../../src/components/topbar';
import { createServerRouter } from '../../src/router';
import { agentNamed } from '../../src/mock/workspace';
import { ProjectsBoard } from '../../src/pages/projects/index/ProjectsBoard';
import { chatsLine } from '../../src/pages/projects/index/ProjectsIndex';
import { cardPills, featureTag, openLinksText, unassignedText } from '../../src/pages/projects/index/model';
import { mountRoute, page, texts, tick } from '../pages/mount';

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function mountBoard(props: Parameters<typeof ProjectsBoard>[0]): Promise<HTMLDivElement> {
    const router = createServerRouter('/projects');
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(<ProjectsBoard {...props} />);
    app.use(router);
    app.mount(container);
    await tick();
    closers.push(() => { app.unmount(); container.remove(); });
    return container;
}

describe('/projects (mock)', () => {
    it('draws the board: count, New project, tabs with the links count, the open-links strip and the unassigned strip', async () => {
        const dom = await mountRoute('/projects');
        const board = page(dom, 'projects')!;
        expect(board).not.toBeNull();
        expect(board.querySelector('[data-projects-count]')!.textContent).toBe('2');
        expect(board.querySelector('[data-projects-head] a')!.getAttribute('href')).toBe('/projects/new');
        const tabs = [...board.querySelectorAll<HTMLElement>('.projects-tab')];
        expect(tabs.map((t) => t.getAttribute('href'))).toEqual(['/projects', '/projects/links']);
        expect(tabs[0]!.getAttribute('aria-current')).toBe('page');
        expect(tabs[1]!.textContent).toBe('Links2');
        const strip = board.querySelector('[data-projects-links-strip]')!;
        expect(strip.textContent).toContain('2 open links across projects');
        expect(strip.querySelector('a')!.getAttribute('href')).toBe('/projects/links');
        const outside = board.querySelector('[data-projects-unassigned]')!;
        expect(outside.textContent).toContain('4 chats and 1 task are not in a project');
        expect(outside.querySelector('a')!.getAttribute('href')).toBe('/chats?project=none');
        // New project lives in the page head now, not the topbar.
        expect(topbarFor({ name: 'projects', path: '/projects', params: {} })?.actions).toBeUndefined();
        expect(topbarFor({ name: 'project-new', path: '/projects/new', params: {} })?.crumb).toBe('New project');
    });

    it('a card per project: square, name, description, members, feature and place tags, pills and the next line', async () => {
        const dom = await mountRoute('/projects');
        const cards = [...dom.querySelectorAll<HTMLElement>('[data-project-row]')];
        expect(cards.map((c) => c.getAttribute('data-project-row'))).toEqual(['p_agentic', 'p_docs']);
        const [agentic, docs] = cards as [HTMLElement, HTMLElement];
        expect(agentic.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic');
        expect(agentic.querySelector('[data-ag-project="square"]')).not.toBeNull();
        expect(agentic.querySelector('[data-project-name]')!.textContent).toBe('agentic');
        expect(agentic.querySelector('[data-project-description]')!.textContent).toBe('The Unified Agent Platform monorepo.');
        expect(agentic.querySelectorAll('[data-member-tiles] [data-scope="avatar"][data-part="root"]').length).toBe(3);
        expect(texts([...agentic.querySelectorAll('.project-feature')])).toEqual(['git']);
        expect(texts([...agentic.querySelectorAll('.project-env')])).toEqual(['alien01', 'alien01 / personal']);
        expect(texts([...agentic.querySelectorAll('[data-project-pills] [data-status]')])).toEqual(['3 YOUR MOVE', '4 AGENTS ON IT']);
        expect(agentic.querySelector('[data-project-next]')!.textContent).toBe('Next: merge #602 · review #598 · decide #605');
        expect(texts([...docs.querySelectorAll('[data-project-pills] [data-status]')])).toEqual(['QUIET']);
        expect(docs.querySelector('[data-project-description]')).toBeNull();
    });
});

describe('ProjectsBoard states', () => {
    it('shows three skeleton cards while loading, and no count', async () => {
        const dom = await mountBoard({ cards: [], machines: [], lookup: agentNamed, loading: true });
        expect(dom.querySelector('[data-projects-index]')!.getAttribute('aria-busy')).toBe('true');
        expect(dom.querySelector('[data-projects-grid]')!.children.length).toBe(3);
        expect(dom.querySelector('[data-projects-count]')).toBeNull();
        expect(dom.querySelector('[data-project-row]')).toBeNull();
    });

    it('shows the empty state with New project, and hides the strips and the links count without sources', async () => {
        const dom = await mountBoard({ cards: [], machines: [], lookup: agentNamed });
        expect(dom.textContent).toContain('No projects yet');
        expect(dom.querySelector('[data-projects-grid]')).toBeNull();
        expect(dom.querySelector('[data-projects-links-strip]')).toBeNull();
        expect(dom.querySelector('[data-projects-unassigned]')).toBeNull();
        expect(dom.querySelector('[data-projects-tab-count]')).toBeNull();
        expect(dom.querySelector('[data-projects-count]')!.textContent).toBe('0');
    });

    it('a card without counts draws no pills', async () => {
        const project = { id: 'p_x', name: 'x', members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features: {}, createdAt: 0, updatedAt: 0 } as unknown as ProjectRecord;
        const dom = await mountBoard({ cards: [{ project, next: 'No chats yet' }], machines: [], lookup: agentNamed, unassigned: { chats: 0 } });
        expect(dom.querySelector('[data-project-pills]')).toBeNull();
        expect(dom.querySelector('[data-project-next]')!.textContent).toBe('No chats yet');
        expect(dom.querySelector('[data-projects-unassigned]')).toBeNull();
    });
});

describe('the index model', () => {
    it('pills: your move, agents on it (singular at one), quiet only when both are known zero', () => {
        expect(cardPills({ yourMove: 1, agentsOnIt: 1 }).map((p) => p.label)).toEqual(['1 YOUR MOVE', '1 AGENT ON IT']);
        expect(cardPills({ yourMove: 0, agentsOnIt: 2 }).map((p) => [p.label, p.tone])).toEqual([['2 AGENTS ON IT', 'working']]);
        expect(cardPills({ yourMove: 0, agentsOnIt: 0 })).toEqual([{ kind: 'quiet', label: 'QUIET', tone: 'dim', hollow: true }]);
        expect(cardPills({})).toEqual([]);
        expect(cardPills({ yourMove: 0 })).toEqual([]);
    });

    it('strip lines and feature tags', () => {
        expect(unassignedText(undefined)).toBe('');
        expect(unassignedText({ chats: 0, tasks: 0 })).toBe('');
        expect(unassignedText({ chats: 1 })).toBe('1 chat is not in a project');
        expect(unassignedText({ chats: 0, tasks: 3 })).toBe('3 tasks are not in a project');
        expect(unassignedText({ chats: 2, tasks: 1 })).toBe('2 chats and 1 task are not in a project');
        expect(openLinksText({ count: 1, summary: '' })).toBe('1 open link across projects');
        expect(featureTag('agentic.feature.git')).toBe('git');
        expect(featureTag('Plan')).toBe('plan');
    });

    it('a live card line from its summary', () => {
        expect(chatsLine(0, undefined, 0)).toBe('No chats yet');
        expect(chatsLine(1, undefined, 0)).toBe('1 open chat');
        expect(chatsLine(3, 0, 2 * 3_600_000)).toBe('3 open chats · active 2 h ago');
    });
});
