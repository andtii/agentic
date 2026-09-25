import { routes, createServerRouter } from '../src/router';
import { CRUMBS, NAV, NAV_GROUPS, needsYouCount } from '../src/nav';
import { agentById, chatById, machineById, sampleIds, sessionById, taskById } from '../src/mock/data';
import { loadChat, loadSession, loadTask } from '../src/mock/workspace';

/** The route skeleton docs/architecture.md §10 and issue #23 require. */
const REQUIRED = [
    '/', '/chats', '/chats/new', '/chats/:id', '/projects', '/projects/new', '/projects/:id', '/agents', '/agents/:id', '/tasks', '/tasks/:id', '/sessions/:id',
    '/machines', '/machines/:id', '/schedules', '/plugins', '/settings', '/pair', '/history', '/usage'
];

/** The projects redesign's routes (#725, docs/design/projects/HANDOFF.md → "Routes"), in table order. */
const PROJECT_ROUTES = [
    ['/projects', 'projects'],
    ['/projects/links', 'projects-links'],
    ['/projects/new', 'project-new'],
    ['/projects/:id', 'project'],
    ['/projects/:id/chats', 'project-chats'],
    ['/projects/:id/work', 'project-work'],
    ['/projects/:id/work/:item', 'project-work-item'],
    ['/projects/:id/requests', 'project-requests'],
    ['/projects/:id/plan', 'project-plan'],
    ['/projects/:id/settings/:tab', 'project-settings'],
    ['/projects/:id/f/:feature', 'project-feature']
] as const;

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
        expect(groups[0]!.items.map(i => i.href)).toEqual(['/', '/chats', '/projects', '/agents', '/machines', '/schedules']);
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
        // The project pages crumb to the list (#333); `/projects/new` is declared before `/projects/:id`, so "new" is never an id.
        expect(CRUMBS['project-new']!.href).toBe('/projects');
        expect(CRUMBS.project!.href).toBe('/projects');
        expect(routes.findIndex(r => r.path === '/projects/new')).toBeLessThan(routes.findIndex(r => r.path === '/projects/:id'));
        // The deep link (#336) crumbs to the list too, and is declared before `/chats/:id`.
        expect(CRUMBS['chat-new']!.href).toBe('/chats');
        expect(routes.findIndex(r => r.path === '/chats/new')).toBeLessThan(routes.findIndex(r => r.path === '/chats/:id'));
    });

    it('resolves /chats/new as the New chat entry with its query, not a chat id (#336)', async () => {
        const router = createServerRouter('/chats/new?env=env_work&path=C%3A%5CDev%5Cagentic&origin=git%40github.com%3Aandtii%2Fagentic.git');
        await router.isReady();
        expect(router.currentRoute.name).toBe('chat-new');
        expect(router.currentRoute.query).toEqual({ env: 'env_work', path: 'C:\\Dev\\agentic', origin: 'git@github.com:andtii/agentic.git' });
        const chat = createServerRouter('/chats/c1');
        await chat.isReady();
        expect(chat.currentRoute.name).toBe('chat');
        expect(chat.currentRoute.params.id).toBe('c1');
    });

    it('declares the projects redesign routes in order, literals before `:id`, each crumbed from Projects (#725)', async () => {
        const table = routes.filter((r) => r.path.startsWith('/projects')).map((r) => [r.path, r.name] as const);
        expect(table).toEqual(PROJECT_ROUTES);
        for (const [, name] of PROJECT_ROUTES) expect(CRUMBS[name]!.href, name).toBe('/projects');
        for (const [path, name] of [['/projects/links', 'projects-links'], ['/projects/p1/work/pr:603', 'project-work-item'], ['/projects/p1/settings/members', 'project-settings'], ['/projects/p1/f/agentic.feature.git', 'project-feature']] as const) {
            const router = createServerRouter(path);
            await router.isReady();
            expect(router.currentRoute.name, path).toBe(name);
        }
    });

    it('draws a project’s menu under Projects only when one is given, keeping the nav order (#725)', () => {
        const menu = [{ label: 'agentic', items: [{ href: '/projects/p1', label: 'Overview' }] }];
        const projects = NAV_GROUPS(0, menu)[0]!.items.find((i) => i.href === '/projects')!;
        expect(projects.children).toEqual(menu);
        expect(NAV_GROUPS(0, menu)[0]!.items.map((i) => i.href)).toEqual(['/', '/chats', '/projects', '/agents', '/machines', '/schedules']);
        expect(NAV_GROUPS(0)[0]!.items.find((i) => i.href === '/projects')!.children).toBeUndefined();
    });

    it('resolves /projects/new as the New project route, not a project id (#333)', async () => {
        const router = createServerRouter('/projects/new');
        await router.isReady();
        expect(router.currentRoute.name).toBe('project-new');
        const edit = createServerRouter('/projects/p_agentic');
        await edit.isReady();
        expect(edit.currentRoute.name).toBe('project');
        expect(edit.currentRoute.params.id).toBe('p_agentic');
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
