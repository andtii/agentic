/**
 * The Pulls actor's `needs-sign-in` on the project's pages (#915): a repo with no GitHub credential shows a sign-in /
 * connector call to action on Work and on the PR page — never the poll's raw error — and nothing once it reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PullRequest } from '@agentic/core';
import { definePullsActor, pullsKey, type PullSource } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const pr: PullRequest = {
    provider: 'github', repo: 'octo/agentic', number: 3, title: 'Readable', url: 'https://github.com/octo/agentic/pull/3',
    head: 'x', base: 'main', state: 'open', additions: 1, deletions: 0, files: 1, openedBy: 'forge', openedAt: 1_000,
    checks: [], review: { state: 'none', reviewers: [], threads: [] }
};

describe('Pulls needs-sign-in on the project pages (#915)', () => {
    let h: LiveHarness;
    let signedIn = false;
    const source: PullSource = { get: async (_repo, n) => (n === 3 ? pr : undefined), listOpen: async () => [pr] };
    const Pulls = definePullsActor({ sources: { open: () => (signedIn ? source : undefined) } });
    beforeEach(async () => {
        signedIn = false;
        h = await startLive(undefined, { actors: [Pulls] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    it('Work and the PR page show the call to action, not the raw error; a good read clears it', { timeout: 20_000 }, async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const pulls = h.app.as(owner).actor(Pulls, pullsKey(WS, id));
        const view = await pulls.watch({ provider: 'github', repo: 'octo/agentic' });
        expect(view.readiness).toBe('needs-sign-in');

        const work = await mountLive(`/projects/${id}/work`, h);
        await until(() => work.querySelector('[data-pulls-sign-in]') !== null, 'the sign-in call to action on Work');
        const cta = work.querySelector('[data-pulls-sign-in]')!;
        expect(cta.textContent).toContain('Sign in to GitHub');
        expect(cta.textContent).not.toContain(view.error!);
        expect(cta.querySelector(`a[href="/projects/${id}/settings/connectors"]`)).not.toBeNull();

        const page = await mountLive(`/projects/${id}/work/pr:3`, h);
        await until(() => page.querySelector('[data-pulls-sign-in]') !== null, 'the sign-in call to action on the PR page');
        expect(page.textContent).not.toContain('No pull request #3');

        signedIn = true;
        const after = await pulls.poll();
        expect(after.readiness).toBeUndefined();
        const again = await mountLive(`/projects/${id}/work`, h);
        await until(() => again.querySelector('[data-work-rows]') !== null || again.querySelector('[data-work-title]') !== null, 'the work board');
        expect(again.querySelector('[data-pulls-sign-in]')).toBeNull();
    });
});
