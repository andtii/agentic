/**
 * The Pulls actor's readiness (#840): no source for the repo (no adapter or credential) is `needs-sign-in` on the
 * view, not a silent failure; a source that throws is only an error; a good read clears both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ProjectId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { TaskActor } from '../../src/task/index';
import { definePullsActor, pullsKey, type PullSource } from '../../src/pulls/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };

let opened: PullSource | undefined | 'throw';
let app: TestActorApp;
let Pulls: ReturnType<typeof definePullsActor>;

const good: PullSource = { get: async () => undefined, listOpen: async () => [] };

beforeEach(() => {
    opened = undefined;
    Pulls = definePullsActor({
        sources: {
            open: () => {
                if (opened === 'throw') throw new Error('boom');
                return opened;
            }
        },
        audit: capturingAuditPort()
    });
    app = testActorApp([TaskActor, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const pulls = () => app.as(user).actor(Pulls, pullsKey(ws, project));

describe('Pulls readiness', () => {
    it('no credential → needs-sign-in; a credential → cleared; a broken source → error only', async () => {
        const first = await pulls().watch({ provider: 'github', repo: 'o/r' });
        expect(first.readiness).toBe('needs-sign-in');
        expect(first.error).toMatch(/no adapter or credential/);
        expect(first.next).toBeDefined(); // it keeps polling, backed off

        opened = good;
        const signedIn = await pulls().watch({ provider: 'github', repo: 'o/r2' });
        expect(signedIn).not.toHaveProperty('readiness');
        expect(signedIn).not.toHaveProperty('error');

        opened = 'throw';
        const broken = await pulls().watch({ provider: 'github', repo: 'o/r3' });
        expect(broken.error).toBe('boom');
        expect(broken).not.toHaveProperty('readiness');
    });

    it('a good poll of the same repo clears needs-sign-in', async () => {
        expect((await pulls().watch({ provider: 'github', repo: 'o/r' })).readiness).toBe('needs-sign-in');
        opened = good;
        const view = await pulls().poll();
        expect(view).not.toHaveProperty('readiness');
        expect(view).not.toHaveProperty('error');
    });
});
