/**
 * `/projects/links` (#765, PRJ-17): the pure layout (`linksLayout` — lanes, columns, arrows, the highlighted chain),
 * `chainOf` / `linkChains` / `linkCount`, and the page on mock data: the toggle, the graph matching the board, the
 * chain panel, the stacked chains, and the empty state live.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { setDataMode } from '../../src/data-mode';
import { MOCK_PROJECT_LINKS } from '../../src/mock/projects/links';
import {
    chainOf,
    linkChains,
    linkCount,
    linksLayout,
    LINKS_ANCHOR_Y,
    LINKS_COL_GAP,
    LINKS_COL_X,
    LINKS_HEAD,
    LINKS_LANE_H,
    LINKS_NODE_TOP,
    LINKS_NODE_W,
    LINKS_PAD,
    milestonesOf,
    toggleLabel,
    type LinkItem,
    type LinksView
} from '../../src/pages/projects/links/model';
import { mountRoute, page, tick } from '../pages/mount';

const item = (ref: string, projectId: string, after: string[] = [], extra: Partial<LinkItem> = {}): LinkItem => ({ ref, projectId, state: 'ready', title: ref, meta: '', after, ...extra });
const view = (items: LinkItem[], lanes = ['a', 'b', 'c']): LinksView => ({ lanes: lanes.map((p) => ({ projectId: p, name: p })), items });
const STEP = LINKS_NODE_W + LINKS_COL_GAP;

describe('linksLayout (#765)', () => {
    it('lays the mock out as the board: three 150px lanes, columns by depth, a busy lane column moves right', () => {
        const g = linksLayout(MOCK_PROJECT_LINKS.open);
        expect(g.lanes.map((l) => [l.name, l.y])).toEqual([['agentic', 0], ['SignalX', 150], ['zero-wip', 300]]);
        const at = Object.fromEntries(g.nodes.map((n) => [n.ref, [n.x, n.y]]));
        expect(at).toEqual({
            'signalx#14': [200, 180],
            'agentic#16': [500, 30],
            'agentic 0.5': [800, 30],
            'signalx#13': [500, 180],
            'zero-wip#7': [500, 330],
            'zero-wip#8': [800, 330]
        });
        expect(g.height).toBe(450);
        expect(g.width).toBe(LINKS_COL_X + 3 * STEP - LINKS_COL_GAP + LINKS_PAD);
    });

    it('draws each arrow from the right edge of the item waited on to the left edge of the waiting one', () => {
        const g = linksLayout(MOCK_PROJECT_LINKS.open);
        const e = g.edges.find((x) => x.from === 'signalx#14' && x.to === 'agentic#16')!;
        expect(e.d).toBe('M430 212 C465 212, 465 62, 494 62');
        expect(e.head).toBe('M492 58 L500 62 L492 66');
        expect(g.edges.map((x) => `${x.from}>${x.to}`).sort()).toEqual(['agentic#16>agentic 0.5', 'signalx#13>zero-wip#8', 'signalx#14>agentic#16', 'signalx#14>zero-wip#7']);
    });

    it('marks an arrow highlighted only when both ends are on the chain', () => {
        const g = linksLayout(MOCK_PROJECT_LINKS.open, new Set(['signalx#14', 'agentic#16', 'agentic 0.5']));
        expect(g.edges.filter((e) => e.highlighted).map((e) => `${e.from}>${e.to}`).sort()).toEqual(['agentic#16>agentic 0.5', 'signalx#14>agentic#16']);
    });

    it('drops lanes without items, items without a lane, unknown and self refs, and ends on a cycle', () => {
        const g = linksLayout(view([item('a#1', 'a', ['a#1', 'z#9']), item('x#1', 'x'), item('c#1', 'c', ['c#2']), item('c#2', 'c', ['c#1'])]));
        expect(g.lanes.map((l) => l.projectId)).toEqual(['a', 'c']);
        expect(g.nodes.map((n) => n.ref)).toEqual(['a#1', 'c#1', 'c#2']);
        expect(g.nodes[0]).toMatchObject({ lane: 0, col: 0, x: LINKS_COL_X, y: LINKS_NODE_TOP });
        expect(new Set(g.nodes.slice(1).map((n) => n.col))).toEqual(new Set([0, 1]));
        expect(g.nodes[1]!.y).toBe(LINKS_LANE_H + LINKS_NODE_TOP);
        expect(g.edges).toHaveLength(2);
    });

    it('keeps arrows pointing right when a lane column is taken', () => {
        const g = linksLayout(view([item('a#1', 'a'), item('a#2', 'a'), item('b#1', 'b', ['a#2'])]));
        const col = Object.fromEntries(g.nodes.map((n) => [n.ref, n.col]));
        expect(col).toEqual({ 'a#1': 0, 'a#2': 1, 'b#1': 2 });
        const e = g.edges[0]!;
        expect(e.d.startsWith(`M${LINKS_COL_X + STEP + LINKS_NODE_W} ${LINKS_NODE_TOP + LINKS_ANCHOR_Y} `)).toBe(true);
        expect(e.d.endsWith(` ${LINKS_COL_X + 2 * STEP - LINKS_HEAD + 2} ${LINKS_LANE_H + LINKS_NODE_TOP + LINKS_ANCHOR_Y}`)).toBe(true);
    });

    it('draws an empty view as nothing', () => {
        expect(linksLayout(view([]))).toMatchObject({ lanes: [], nodes: [], edges: [], height: 0 });
    });
});

describe('chains and counts (#765)', () => {
    it('chainOf lists what a milestone transitively waits on, in unblock order, then itself', () => {
        expect(chainOf(MOCK_PROJECT_LINKS.open, 'agentic 0.5').map((i) => i.ref)).toEqual(['signalx#14', 'agentic#16', 'agentic 0.5']);
        expect(chainOf(MOCK_PROJECT_LINKS.open, 'nope')).toEqual([]);
    });

    it('linkChains gives one chain per item nothing waits on', () => {
        expect(linkChains(MOCK_PROJECT_LINKS.open).map((c) => c.steps.map((s) => s.ref))).toEqual([
            ['signalx#14', 'agentic#16', 'agentic 0.5'],
            ['signalx#14', 'zero-wip#7'],
            ['signalx#13', 'zero-wip#8']
        ]);
    });

    it('counts links as arrows, and names the toggles by them', () => {
        expect(linkCount(MOCK_PROJECT_LINKS.open)).toBe(4);
        expect(toggleLabel('open', MOCK_PROJECT_LINKS.open)).toBe('Open 4');
        expect(toggleLabel('done', MOCK_PROJECT_LINKS.done)).toBe(`Done ${linkCount(MOCK_PROJECT_LINKS.done)}`);
        expect(linkCount(view([item('a#1', 'a', ['a#1', 'a#1'])]))).toBe(0);
        expect(milestonesOf(MOCK_PROJECT_LINKS.open).map((m) => m.ref)).toEqual(['agentic 0.5']);
    });
});

describe('/projects/links (mock)', () => {
    afterEach(() => setDataMode('mock'));

    it('draws the tabs, the Open / Done toggle, lanes with their managers, nodes and arrows', async () => {
        const dom = await mountRoute('/projects/links');
        const p = page(dom, 'projects-links')!;
        expect(p).not.toBeNull();
        expect(p.querySelector('h1')!.textContent).toBe('Links across projects');
        const tabs = [...p.querySelectorAll<HTMLElement>('.projects-tab')];
        expect(tabs[1]!.getAttribute('aria-current')).toBe('page');
        expect(tabs[1]!.textContent).toBe('Links4');
        const toggles = [...p.querySelectorAll<HTMLButtonElement>('[data-links-toggle-option]')];
        expect(toggles.map((t) => [t.textContent, t.getAttribute('aria-pressed')])).toEqual([['Open 4', 'true'], [`Done ${linkCount(MOCK_PROJECT_LINKS.done)}`, 'false']]);
        expect([...p.querySelectorAll('[data-links-lane]')].map((l) => l.textContent)).toEqual(['agenticATPM Atlas', 'SignalXNOPM Nova', 'zero-wipATPM Atlas']);
        expect(p.querySelectorAll('[data-links-node]')).toHaveLength(6);
        expect(p.querySelectorAll('[data-links-edge]')).toHaveLength(4);
        const node = p.querySelector<HTMLElement>('[data-links-node="signalx#14"]')!;
        expect(node.style.left).toBe('200px');
        expect(node.style.width).toBe('230px');
        expect(node.textContent).toContain('batch() keeps updates on throw');
    });

    it('highlights the first milestone’s chain and lists it in the panel with Open plan', async () => {
        const dom = await mountRoute('/projects/links');
        const highlighted = [...dom.querySelectorAll('[data-links-edge][data-highlighted]')].map((e) => e.getAttribute('data-links-edge'));
        expect(highlighted.sort()).toEqual(['agentic#16>agentic 0.5', 'signalx#14>agentic#16']);
        expect(dom.querySelector('[data-links-node="agentic 0.5"] button')!.getAttribute('aria-pressed')).toBe('true');
        const panel = dom.querySelector('[data-links-chain]')!;
        expect(panel.querySelector('h2')!.textContent).toBe('What agentic 0.5 is waiting for');
        expect(panel.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic/plan');
        expect([...panel.querySelectorAll('[data-links-step]')].map((s) => s.getAttribute('data-links-step'))).toEqual(['signalx#14', 'agentic#16', 'agentic 0.5']);
        expect(panel.querySelector('[data-links-step="signalx#14"] [data-links-step-text]')!.getAttribute('data-tone')).toBe('working');
        expect(dom.querySelector('[data-links-highlight]')!.textContent).toContain('agentic 0.5');
        expect(dom.querySelectorAll('[data-links-legend] li')).toHaveLength(3);
    });

    it('renders the stacked chains for narrow screens', async () => {
        const dom = await mountRoute('/projects/links');
        expect([...dom.querySelectorAll('[data-links-chain-card]')].map((c) => c.getAttribute('data-links-chain-card'))).toEqual(['agentic 0.5', 'zero-wip#7', 'zero-wip#8']);
    });

    it('switches to Done and back', async () => {
        const dom = await mountRoute('/projects/links');
        dom.querySelector<HTMLButtonElement>('[data-links-toggle-option="done"]')!.click();
        await tick();
        expect(dom.querySelector('[data-links-toggle-option="done"]')!.getAttribute('aria-pressed')).toBe('true');
        expect([...dom.querySelectorAll('[data-links-node]')].map((n) => n.getAttribute('data-links-node'))).toEqual(MOCK_PROJECT_LINKS.done.items.map((i) => i.ref));
        expect(dom.querySelector('[data-links-chain] h2')!.textContent).toBe('What agentic 0.4 is waiting for');
        dom.querySelector<HTMLButtonElement>('[data-links-toggle-option="open"]')!.click();
        await tick();
        expect(dom.querySelector('[data-links-node="signalx#14"]')).not.toBeNull();
    });

    it('says there are no links live, where nothing lists them yet', async () => {
        setDataMode('live');
        const dom = await mountRoute('/projects/links');
        const p = page(dom, 'projects-links')!;
        expect(p.querySelector('[data-links-canvas]')).toBeNull();
        expect(p.textContent).toContain('No open links across projects');
        expect(p.querySelector('[data-links-toggle-option="open"]')!.textContent).toBe('Open 0');
    });
});
