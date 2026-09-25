/**
 * The projects scaffold (#725) on the live wire: `ProjectLayout` loads the project from `Workspace.projects()`,
 * renders the page inside it, and publishes the project to `projectHead` — what the sidebar's project menu and the
 * crumbs read in live mode. An id the workspace does not have is not found.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clientDefs } from '../../src/actors/client';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import { setDataMode } from '../../src/data-mode';
import { projectHead } from '../../src/pages/projects/head';
import { projectMenuFor } from '../../src/pages/projects/layout/menu';
import { saveProjectWith } from '../../src/pages/projects/live';
import { USER, mountLive, startLive, until, type LiveHarness } from '../pages/live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    projectHead.value = null;
    await h.stop();
});

describe('the project layout on the live pages (#725)', () => {
    it('renders the page inside the layout and publishes the project for the menu and the crumbs', { timeout: 20_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const dom = await mountLive(`/projects/${id}/work`, h);
        await until(() => dom.querySelector(`[data-project-layout="${id}"] [data-page="project-work"]`) !== null, 'the page inside the layout');
        await until(() => projectHead.value?.name === 'agentic', 'the head');
        expect(projectHead.value).toEqual({ id, name: 'agentic', features: [], manager: true });
        const route = { name: 'project-work', path: `/projects/${id}/work`, params: { id } };
        setDataMode('live');
        try {
            expect(trailFor(route, topbarFor(route)).map((c) => c.label)).toEqual(['Projects', 'agentic', 'Work']);
            expect(projectMenuFor(route)![0]!.items.map((i) => i.label)).toEqual(['Overview', 'Chats', 'Work', 'Requests']);
        } finally {
            setDataMode('mock');
        }
    });

    it('an id the workspace does not have is not found', { timeout: 20_000 }, async () => {
        const dom = await mountLive('/projects/p_missing/chats', h);
        await until(() => dom.querySelector('[data-page="project-missing"]') !== null, 'the not-found state');
        expect(dom.querySelector('[data-project-layout]')).toBeNull();
    });
});
