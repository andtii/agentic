import { routes, createServerRouter } from '../src/router';
import { CRUMBS, NAV, NAV_GROUPS, needsYouCount } from '../src/nav';
import { agentById, chatById, machineById, sampleIds, sessionById, taskById } from '../src/mock/data';
import { loadChat, loadSession, loadTask } from '../src/mock/workspace';

/** The route skeleton docs/architecture.md §10 and issue #23 require. */
const REQUIRED = [
    '/', '/chats', '/chats/:id', '/agents', '/agents/:id', '/tasks', '/tasks/:id', '/sessions/:id',
    '/machines', '/machines/:id', '/schedules', '/plugins', '/settings', '/pair', '/history', '/usage'
];

describe('route skeleton', () => {
    it('declares every required route, each with a component', () => {
        const paths = routes.map(r => r.path);
        for (const p of REQUIRED) expect(paths).toContain(p);
        for (const r of routes) expect(r.component, r.path).toBeTruthy();
    });

    it('every primary nav entry is a declared route', () => {
        const paths = new Set(routes.map(r => r.path));
        for (const item of NAV) expect(paths.has(item.href), item.href).toBe(true);
    });

    it('groups the nav as Primary and Workspace, with the Home badge counting what needs a person', () => {
        const groups = NAV_GROUPS();
        expect(groups.map(g => g.label)).toEqual(['Primary', 'Workspace']);
        expect(groups[0]!.items.map(i => i.href)).toEqual(['/', '/chats', '/agents', '/machines', '/schedules']);
        expect(groups[1]!.items.map(i => i.href)).toEqual(['/history', '/usage', '/plugins', '/settings']);
        expect(groups[0]!.items[0]!.badge).toBe(needsYouCount());
        // The shell passes the count it reads from "Needs you" (#151); nothing open draws no badge.
        expect(NAV_GROUPS(5)[0]!.items[0]!.badge).toBe(5);
        expect(NAV_GROUPS(0)[0]!.items[0]!.badge).toBe(0);
        expect(NAV.some(i => i.href === '/pair')).toBe(false);
    });

    it('has a breadcrumb root for every named route, and the task crumb leads to the tasks list', () => {
        for (const r of routes) expect(CRUMBS[String(r.name)], String(r.name)).toBeDefined();
        expect(CRUMBS.task!.href).toBe('/tasks');
    });

    it('serves History and Usage as real pages (#90)', async () => {
        for (const [path, name] of [['/history', 'history'], ['/usage', 'usage']] as const) {
            const router = createServerRouter(path);
            await router.isReady();
            expect(router.currentRoute.name).toBe(name);
            const record = routes.find(r => r.path === path)!;
            expect((record.component as { __name?: string }).__name ?? '').not.toMatch(/placeholder/i);
        }
    });

    it('resolves a parameterised route with its params on the server', async () => {
        const router = createServerRouter(`/agents/${sampleIds.agent}`);
        await router.isReady();
        expect(router.currentRoute.name).toBe('agent');
        expect(router.currentRoute.params.id).toBe(sampleIds.agent);
    });
});

describe('mock data', () => {
    it('has an entity behind every sample id the smoke test visits', () => {
        expect(chatById(sampleIds.chat)).toBeDefined();
        expect(agentById(sampleIds.agent)).toBeDefined();
        expect(taskById(sampleIds.task)).toBeDefined();
        expect(sessionById(sampleIds.session)).toBeDefined();
        expect(machineById(sampleIds.machine)).toBeDefined();
    });

    it('has a workspace view behind every sample id the core pages load', () => {
        expect(loadChat(sampleIds.chat)).toBeDefined();
        expect(loadTask(sampleIds.task)).toBeDefined();
        expect(loadSession(sampleIds.session)).toBeDefined();
    });

    it('finds nested tasks in the tree', () => {
        expect(taskById('t1-3')?.title).toBe('Playwright smoke');
        expect(taskById('nope')).toBeUndefined();
    });
});
