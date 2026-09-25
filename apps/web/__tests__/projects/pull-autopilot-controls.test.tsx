/**
 * The PR page's autopilot controls on the live wire (#858): the switches → `Pulls.setAutopilot`, Take over / Stop
 * autopilot / Resume → `takeOver` / `stopAutopilot` / `resumeAutopilot`, and Approve / Decline while the autopilot
 * asks to merge → `answerMerge`. On mock data Resume brings the local copy back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PullRequest } from '@agentic/core';
import { definePullsActor, pullsKey, type PullSource, type PullsAutopilotPort } from '@agentic/platform';
import { MOCK_PULLS } from '../../src/mock/projects/pull';
import { findPull } from '../../src/pages/projects/work/pull/model';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { mountRoute, page, tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const agentic = MOCK_PULLS['p_agentic']!;
const board = findPull(agentic, 603)!.pr;
// What a provider reads carries no autopilot: the page's switches are the actor's own (`setAutopilot`).
const { autopilot: fixturePilot, ...read } = board;
const { attempt: _a, activity: _b, ...switches } = fixturePilot!;

describe('Resume on mock data (#858)', () => {
    it('Stop autopilot, then Resume brings the switches back', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/pr:603');
        const el = page(dom, 'project-pull')!;
        el.querySelector<HTMLButtonElement>('button[name="stop-autopilot"]')!.click();
        await tick();
        expect(el.querySelector('[data-pull-now]')?.getAttribute('data-stopped')).toBe('stopped');
        el.querySelector<HTMLButtonElement>('button[name="resume-autopilot"]')!.click();
        await tick();
        expect(el.querySelector('[data-pull-now]')?.hasAttribute('data-stopped')).toBe(false);
        expect([...el.querySelectorAll<HTMLInputElement>('[data-pull-autopilot] input[role="switch"]')].map((s) => s.checked)).toEqual([true, true, true, false]);
    });
});

describe('the autopilot controls on the live wire (#858)', () => {
    let h: LiveHarness;
    let current: PullRequest;
    let merges: number[];
    const source: PullSource = { get: async (_repo, n) => (n === current.number ? current : undefined), listOpen: async () => [current] };
    const port: PullsAutopilotPort = {
        startTurn: async () => undefined,
        merge: async ({ pr }) => {
            merges.push(pr.number);
            return { merged: true };
        }
    };
    const Pulls = () => definePullsActor({ sources: { open: () => source }, autopilot: () => port });

    beforeEach(async () => {
        current = read;
        merges = [];
        h = await startLive(undefined, { actors: [Pulls()] });
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    async function project(pilot = switches): Promise<string> {
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        await h.app.as(owner).actor(Pulls(), pullsKey(WS, id)).watch({ provider: 'github', repo: 'andtii/agentic' });
        await h.app.as(owner).actor(Pulls(), pullsKey(WS, id)).setAutopilot(603, pilot);
        await h.app.as(owner).actor(Pulls(), pullsKey(WS, id)).poll();
        return id;
    }
    const pulls = (id: string) => h.app.as(owner).actor(Pulls(), pullsKey(WS, id));
    const button = (dom: ParentNode, name: string) => dom.querySelector<HTMLButtonElement>(`button[name="${name}"]`);

    it('Stop, Take over and Resume go to the Pulls actor; a switch sets the autopilot', { timeout: 30_000 }, async () => {
        const id = await project();
        const dom = await mountLive(`/projects/${id}/work/pr:603`, h);
        await until(() => button(dom, 'stop-autopilot') !== null, 'the callout');

        button(dom, 'stop-autopilot')!.click();
        await until(() => dom.querySelector('[data-pull-now]')?.getAttribute('data-stopped') === 'stopped', 'stopped');
        expect((await pulls(id).get()).runs['603']).toEqual({ paused: 'off' });

        button(dom, 'resume-autopilot')!.click();
        await until(() => button(dom, 'take-over') !== null, 'resumed');
        expect((await pulls(id).get()).runs['603']?.paused).toBeUndefined();

        button(dom, 'take-over')!.click();
        await until(() => dom.querySelector('[data-pull-now]')?.getAttribute('data-stopped') === 'you', 'taken over');
        expect((await pulls(id).get()).runs['603']).toEqual({ paused: 'taken-over' });
        button(dom, 'resume-autopilot')!.click();
        await until(() => button(dom, 'take-over') !== null, 'resumed again');

        // The resume reached the actor before the switch is taken.
        await until(async () => (await pulls(id).get()).runs['603']?.paused === undefined, 'resumed on the actor');
        const merge = dom.querySelector<HTMLInputElement>('[data-switch="mergeWhenGreen"] input[role="switch"]')!;
        expect(merge.checked).toBe(false);
        merge.click();
        await until(async () => (await pulls(id).get()).pulls[0]?.autopilot?.mergeWhenGreen === true, 'the switch set');
        await until(() => dom.querySelector<HTMLInputElement>('[data-switch="mergeWhenGreen"] input[role="switch"]')?.checked === true, 'the switch shown');
    });

    it('asking to merge: Approve merges through the actor', { timeout: 30_000 }, async () => {
        current = {
            ...read,
            checks: [{ name: 'ci', state: 'passed' }],
            mergeable: true,
            review: { state: 'approved', reviewers: ['Lint'], threads: [] }
        };
        const id = await project({ ...switches, mergeWhenGreen: true });
        await until(async () => (await pulls(id).get()).runs['603']?.askingMerge === true, 'the merge asked');
        const dom = await mountLive(`/projects/${id}/work/pr:603`, h);
        await until(() => button(dom, 'approve-merge') !== null, 'Approve');
        expect(button(dom, 'decline-merge')).not.toBeNull();
        button(dom, 'approve-merge')!.click();
        await until(() => merges.length === 1, 'the merge');
        expect(merges).toEqual([603]);
        await until(() => button(dom, 'approve-merge') === null, 'the ask answered');
    });
});
