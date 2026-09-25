/**
 * Per-project GitHub credential (#840) on the real `ActorHost`: the Pulls actor of a project with no GitHub
 * connector, and a workspace with no GitHub token, says `needs-sign-in` on its view instead of failing silently.
 * Once the workspace stores its `github-token`, the next poll reads and the readiness clears. The reads go through
 * `projectPullToken` over the worker's own Registry and Workspace (`./pulls-source.ts`, `workerPullSources`).
 */
import type { WorkspaceId } from '@agentic/core';
import { definePullsActor, NO_PULL_SOURCES, pullsKey, Registry, registryKey, Workspace, workspaceKey } from '@agentic/platform';
import { GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { overHttp, signIn } from './http';

const userId = 'gh_8400';
const workspaceId = userId as WorkspaceId;
/** Only its `type` ('pulls') matters to `overHttp`; the host runs the app's own definition. */
const Pulls = definePullsActor({ sources: NO_PULL_SOURCES });

describe('worker: Pulls per-project credential', () => {
    it('a project without a credential shows needs-sign-in; the workspace token clears it', async () => {
        const cookie = await signIn(userId);
        const project = await overHttp(Workspace, workspaceKey(workspaceId), cookie).upsertProject({ name: 'No creds' });
        const pulls = overHttp(Pulls, pullsKey(workspaceId, project.id), cookie);

        const view = await pulls.watch({ provider: 'github', repo: 'octo/no-creds' });
        expect(view.readiness).toBe('needs-sign-in');
        expect(view.error).toMatch(/no adapter or credential/);
        expect(view.pulls).toEqual([]);

        await overHttp(Registry, registryKey(workspaceId), cookie).setSecret(GITHUB_TOKEN_SECRET, 'ghp_workers_token');
        const after = await pulls.poll();
        expect(after).not.toHaveProperty('readiness');
        expect(after).not.toHaveProperty('error');
    });
});
