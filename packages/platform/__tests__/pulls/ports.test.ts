/** `tokenPullSources` (#742): the ref's adapter over its credential, reused for a while so a poll does not open the secret every minute. */
import { describe, expect, it } from 'vitest';
import type { ProjectId, WorkspaceId } from '@agentic/core';
import { NO_PULL_SOURCES, PULL_SOURCE_TTL_MS, tokenPullSources, type PullSource, type PullSourceRef } from '../../src/pulls/index';

const ref = (over: Partial<PullSourceRef> = {}): PullSourceRef => ({ workspaceId: 'ws_1' as WorkspaceId, projectId: 'prj_1' as ProjectId, provider: 'github', repo: 'o/r', ...over });
const fake = (token: string): PullSource & { token: string } => ({ token, get: async () => undefined, listOpen: async () => [] });

describe('tokenPullSources', () => {
    it('builds the adapter from the credential and reuses it until the ttl runs out', async () => {
        let clock = 0;
        const asked: string[] = [];
        const port = tokenPullSources({
            adapters: { github: fake },
            token: async (r) => {
                asked.push(r.workspaceId);
                return `tok_${asked.length}`;
            },
            now: () => clock
        });
        const first = (await port.open(ref())) as ReturnType<typeof fake>;
        expect(first.token).toBe('tok_1');
        clock = PULL_SOURCE_TTL_MS - 1;
        expect(await port.open(ref({ projectId: 'prj_2' as ProjectId }))).toBe(first); // per workspace and provider
        clock = PULL_SOURCE_TTL_MS;
        expect(((await port.open(ref())) as ReturnType<typeof fake>).token).toBe('tok_2');
        expect(((await port.open(ref({ workspaceId: 'ws_2' as WorkspaceId }))) as ReturnType<typeof fake>).token).toBe('tok_3');
    });

    it('no adapter or no credential is no source, and a missing credential is asked again next time', async () => {
        let token: string | undefined;
        let asked = 0;
        const port = tokenPullSources({
            adapters: { github: fake },
            token: async () => {
                asked++;
                return token;
            }
        });
        expect(await port.open(ref({ provider: 'gitlab' }))).toBeUndefined();
        expect(asked).toBe(0);
        expect(await port.open(ref())).toBeUndefined();
        token = 'tok';
        expect(await port.open(ref())).toBeDefined();
        expect(asked).toBe(2);
        expect(NO_PULL_SOURCES.open(ref())).toBeUndefined();
    });
});
