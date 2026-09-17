import { routes, createServerRouter } from '../src/router';
import { NAV } from '../src/nav';
import { agentById, chatById, machineById, sampleIds, sessionById, taskById } from '../src/mock/data';

/** The route skeleton docs/architecture.md §10 and issue #23 require. */
const REQUIRED = [
    '/', '/chats/:id', '/agents', '/agents/:id', '/tasks/:id', '/sessions/:id',
    '/machines', '/machines/:id', '/schedules', '/plugins', '/settings', '/pair'
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

    it('finds nested tasks in the tree', () => {
        expect(taskById('t1-3')?.title).toBe('Playwright smoke');
        expect(taskById('nope')).toBeUndefined();
    });
});
