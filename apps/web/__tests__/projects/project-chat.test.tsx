/**
 * A project's chat opens inside the project (#929, board PMChat), on mock data: `/projects/:id/chats/:chatId` draws the
 * chat's thread and context panel inside `ProjectLayout` with no global list, the menu's Chats is where it sits, the
 * crumbs read `Projects › <project> › Chats › <chat>`; `/chats/:id` of a project's chat replaces itself with that
 * route, a chat in no project stays at `/chats/:id`, and the project's pages link their chats there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { topbarFor } from '../../src/components/topbar';
import { backOf, trailFor } from '../../src/crumbs';
import { createServerRouter } from '../../src/router';
import { PROJECT_ROUTE_NAMES, projectMenuFor } from '../../src/pages/projects/layout/menu';
import { page, tick } from '../pages/mount';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** Mount `path` and keep the router, so a test can read where the page moved to. */
async function mount(path: string) {
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(<RouterView />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return { dom: container, router };
}

const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 50; i++) {
        if (ok()) return;
        await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
};

const routeOf = (router: ReturnType<typeof createServerRouter>) => {
    const r = router.currentRoute;
    return { name: r.name, path: r.path, params: r.params as Record<string, string> };
};

describe('a project’s chat inside the project (#929)', () => {
    it('renders the thread and context panel inside the project layout, without the global chat list', async () => {
        const { dom, router } = await mount('/projects/p_agentic/chats/c4');
        expect(router.currentRoute.name).toBe('project-chat');
        expect(PROJECT_ROUTE_NAMES.has('project-chat')).toBe(true);
        const layout = dom.querySelector<HTMLElement>('[data-project-layout="p_agentic"]');
        expect(layout).not.toBeNull();
        const chat = page(layout!, 'chat');
        expect(chat).not.toBeNull();
        expect(chat!.querySelector('[data-chat-main]')).not.toBeNull();
        expect(chat!.querySelector(':scope > [data-chat-context]')).not.toBeNull();
        expect(dom.querySelector('[data-chat-list]')).toBeNull();
        expect(router.currentRoute.path).toBe('/projects/p_agentic/chats/c4');
    });

    it('crumbs Projects › agentic › Chats › the chat, back to the project’s chats, and keeps the project menu with Chats', async () => {
        const { router } = await mount('/projects/p_agentic/chats/c4');
        const route = routeOf(router);
        const trail = trailFor(route, topbarFor(route));
        expect(trail.map((c) => c.label)).toEqual(['Projects', 'agentic', 'Chats', 'Release checklist']);
        expect(trail.map((c) => c.href)).toEqual(['/projects', '/projects/p_agentic', '/projects/p_agentic/chats', '/projects/p_agentic/chats/c4']);
        expect(backOf(trail)).toBe('/projects/p_agentic/chats');
        const menu = projectMenuFor(route)!;
        expect(menu[0]!.label).toBe('agentic');
        expect(menu[0]!.items.find((i) => i.label === 'Chats')!.href).toBe('/projects/p_agentic/chats');
    });

    it('opening /chats/:id of a project’s chat lands on the project route', async () => {
        const { dom, router } = await mount('/chats/c4');
        await until(() => router.currentRoute.name === 'project-chat', 'the project route');
        expect(router.currentRoute.path).toBe('/projects/p_agentic/chats/c4');
        await until(() => dom.querySelector('[data-project-layout="p_agentic"] [data-page="chat"]') !== null, 'the chat inside the project');
    });

    it('keeps the query when it moves, so a mention from a session still lands in the composer', async () => {
        const { router } = await mount('/chats/c4?file=x');
        await until(() => router.currentRoute.name === 'project-chat', 'the project route');
        expect(router.currentRoute.query).toEqual({ file: 'x' });
    });

    it('a chat in no project stays at /chats/:id with the global list', async () => {
        const { dom, router } = await mount('/chats/c1');
        await tick();
        await tick();
        expect(router.currentRoute.name).toBe('chat');
        expect(router.currentRoute.path).toBe('/chats/c1');
        expect(dom.querySelector('[data-page="chat"] > [data-chat-list]')).not.toBeNull();
    });

    it('opening another chat from the list stays on that chat: the page on its way out never pulls the route back', async () => {
        const { dom, router } = await mount('/chats/c1');
        dom.querySelector<HTMLAnchorElement>('[data-chat-list] a[href="/chats/c3"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        await until(() => router.currentRoute.path === '/chats/c3', 'the other chat');
        for (let i = 0; i < 5; i++) await tick();
        expect(router.currentRoute.path).toBe('/chats/c3');
    });

    it('a chat opened under the wrong project moves to its own', async () => {
        const { router } = await mount('/projects/p_docs/chats/c4');
        await until(() => router.currentRoute.path === '/projects/p_agentic/chats/c4', 'the chat’s own project');
    });

    it('the global list links a project’s chat inside its project', async () => {
        const { dom } = await mount('/chats');
        expect(dom.querySelector('[data-chat-list] a[href="/projects/p_agentic/chats/c4"]')).not.toBeNull();
        expect(dom.querySelector('[data-chat-list] a[href="/chats/c1"]')).not.toBeNull();
    });

    it('the project’s Chats page links its rows inside the project, and New chat opens on the project', async () => {
        const { dom } = await mount('/projects/p_agentic/chats');
        const links = [...dom.querySelectorAll<HTMLAnchorElement>('[data-project-chat-row] a')].map((a) => a.getAttribute('href'));
        expect(links.length).toBeGreaterThan(0);
        for (const href of links.filter((h) => !h!.startsWith('/tasks/') && !h!.includes('/work/'))) expect(href).toMatch(/^\/projects\/p_agentic\/chats\//);
        expect(dom.querySelector('[data-project-chats-actions] a[href="/chats/new?project=p_agentic"]')).not.toBeNull();
    });
});
