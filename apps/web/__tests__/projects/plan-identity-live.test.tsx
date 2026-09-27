/**
 * The Plan views know who is looking (#939): live, "You" and "Mine" are the signed-in user (ViewerState.userId), the
 * crew and owners carry the agents' real names, a board drop on You assigns the item to the viewer, every view has
 * the plan switcher and the List / Board / Graph toggle, Runs as comes from the claim's task, and a file ref's hover
 * card reads its pinned lines through `fs read-at` — here a fake fs — or says the machine is offline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineApp, type JSXElement } from 'sigx';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import type { AgentId, FsError, FsOp, FsResult, Plan, PlanActor, PlanItem, ProjectId, ProjectRecord, TaskId } from '@agentic/core';
import { definePlanActor, planKey, Workspace, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { useActorDefs, useViewer } from '../../src/actors/defs';
import { setDataMode } from '../../src/data-mode';
import { createServerRouter } from '../../src/router';
import { PlanBoard } from '../../src/pages/projects/features/plan/board/PlanBoard';
import { PlanGraph } from '../../src/pages/projects/features/plan/graph/PlanGraph';
import { ItemDetail } from '../../src/pages/projects/features/plan/list/ItemDetail';
import { PlanList } from '../../src/pages/projects/features/plan/list/PlanList';
import { claimTaskIds, livePlanIdentity, runOfTask, runsOf } from '../../src/pages/projects/features/plan/shared/data';
import { createPinSource, pinPlaceOf, type PinFs, type PinPlace } from '../../src/pages/projects/features/plan/shared/pins';
import { unknownAgent } from '../../src/pages/chat/live';
import { saveProjectWith } from '../../src/pages/projects/live';
import { mountAt, text } from '../pages/helpers';
import { USER, WS, owner, startLive, texts, tick, until, type LiveHarness } from '../pages/live-harness';

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `#${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const me: PlanActor = { kind: 'user', userId: USER };

describe('the live plan identity (#939)', () => {
    const lookup = (id: string) => (id === 'a1' ? { ...unknownAgent(id), name: 'Forge', hue: 3 as const } : unknownAgent(id));

    it('names the viewer You, an agent by the directory, another person by id', () => {
        const id = livePlanIdentity({ userId: USER, login: 'andii' }, lookup);
        expect(id.me()).toEqual(me);
        expect(id.look(me)).toEqual({ name: 'You', person: true, monogram: 'AN' });
        expect(id.look({ kind: 'agent', agentId: 'a1' as AgentId })).toEqual({ name: 'Forge', hue: 3, person: false });
        expect(id.name({ kind: 'user', userId: 'u_other' })).toBe('u_other');
    });

    it('is nobody before whoami answers', () => {
        const id = livePlanIdentity({ userId: null, login: null }, lookup);
        expect(id.name(id.me())).toBe('');
        expect(id.name({ kind: 'user', userId: USER })).toBe(USER);
    });
});

describe('Runs as from the claim’s task (#939)', () => {
    const plan: Plan = {
        id: 'p', projectId: 'p_x' as ProjectId, title: 'P',
        phases: [{ n: 1, title: 'A', items: [
            item(1, { state: 'claimed', claim: { agentId: 'a1' as AgentId, leaseUntil: 1, taskId: 't_b' as TaskId } }),
            item(2, { state: 'done', claim: { agentId: 'a1' as AgentId, leaseUntil: 1, taskId: 't_done' as TaskId } }),
            item(3, { state: 'claimed', claim: { agentId: 'a1' as AgentId, leaseUntil: 1, taskId: 't_a' as TaskId } })
        ] }]
    };

    it('reads only the open items’ tasks, sorted', () => {
        expect(claimTaskIds([plan])).toEqual(['t_a', 't_b']);
    });

    it('maps each task to the item it runs', () => {
        const run = runOfTask({ id: 't_b' as TaskId, machineId: 'm1' as never, environmentId: 'env1' as never, workdir: 'C:/repo', sessionId: 's9' as never });
        expect(run).toEqual({ taskId: 't_b', taskRef: 't_b', machine: 'm1', machineId: 'm1', environmentId: 'env1', workdir: 'C:/repo', sessionId: 's9' });
        expect(runsOf(plan, { t_b: run })).toEqual({ 1: run });
    });
});

describe('where a pinned file is read (#939)', () => {
    const envs = [
        { id: 'e1', machineId: 'm1', machineName: 'box1', online: false },
        { id: 'e2', machineId: 'm2', machineName: 'box2', online: true }
    ];
    const project = { folders: { 'm1/*': 'D:/one', 'm2/*': 'D:/two' } };

    it('prefers an online machine with the project folder', () => {
        expect(pinPlaceOf(project, envs)).toEqual({ machineId: 'm2', machineName: 'box2', environmentId: 'e2', root: 'D:/two', online: true });
    });

    it('falls back to an offline one, and to nothing without a folder', () => {
        expect(pinPlaceOf({ folders: { 'm1/*': 'D:/one' } }, envs)).toMatchObject({ machineId: 'm1', online: false });
        expect(pinPlaceOf({ folders: {} }, envs)).toBeUndefined();
    });

    it('reads in the task’s folder when the item runs', () => {
        expect(pinPlaceOf(project, envs, { taskId: 't' as TaskId, taskRef: 't', machineId: 'm1', environmentId: 'e1', workdir: 'D:/wt' })).toEqual({ machineId: 'm1', machineName: 'box1', environmentId: 'e1', root: 'D:/wt', online: false });
    });
});

describe('the file hover card over a fake fs (#939)', () => {
    const SHA = '4f2a9c1d0000000000000000000000000000beef';
    const ref = { kind: 'file' as const, path: 'src/model.ts', from: 3, to: 4, sha: SHA };
    const target = item(7, { title: 'Pinned', refs: [ref] });
    const doc = { plan: { id: 'p', projectId: 'p_agentic' as ProjectId, title: 'P', phases: [{ n: 1, title: 'A', items: [target] }] } };
    const online: PinPlace = { machineId: 'm1', machineName: 'box1', environmentId: 'e1', root: 'D:/repo', online: true };

    const mount = (place: PinPlace | undefined, fs: PinFs) =>
        mountAt('/projects/p_agentic/plan', <ItemDetail projectId="p_agentic" doc={doc} item={target} items={[target]} now={0} onPick={() => {}} onClose={() => {}} pins={createPinSource(() => place, fs)} />);
    const open = async (el: HTMLElement): Promise<Element> => {
        el.querySelector<HTMLButtonElement>('[data-plan-chip="file"]')!.click();
        await tick();
        return el.querySelector('[data-plan-pin]')!;
    };

    it('asks read-at for the pinned lines and draws them', async () => {
        const asked: FsOp[] = [];
        const fs: PinFs = async (_m, _e, op) => {
            asked.push(op);
            return { kind: 'read-at', path: ref.path, sha: SHA, from: 3, to: 4, lines: ['const a = 1;', 'const b = 2;'] } satisfies FsResult;
        };
        const el = await mount(online, fs);
        const pin = await open(el);
        await until(() => pin.querySelectorAll('[data-plan-pin-line]').length === 2, 'the pinned lines');
        expect(asked).toEqual([{ kind: 'read-at', root: 'D:/repo', path: 'src/model.ts', sha: SHA, from: 3, to: 4 }]);
        expect(texts(pin.querySelectorAll('[data-plan-pin-line] code'))).toEqual(['const a = 1;', 'const b = 2;']);
        expect(text(pin.querySelector('[data-plan-pin-at]'))).toBe('L3–4 · commit@4f2a9c1');
    });

    it('says the machine is offline, without asking it', async () => {
        let asked = 0;
        const el = await mount({ ...online, online: false }, async () => { asked++; return { code: 'internal', message: 'no' }; });
        const pin = await open(el);
        expect(pin.querySelector('[data-plan-pin-status]')?.getAttribute('data-plan-pin-status')).toBe('offline');
        expect(text(pin.querySelector('[data-plan-pin-status]'))).toBe('box1 is offline, so the pinned lines cannot be read.');
        expect(asked).toBe(0);
    });

    it('shows the daemon’s refusal, and says so when no machine holds the project', async () => {
        const refused = await mount(online, async () => ({ code: 'not-found', message: 'no such commit' }) satisfies FsError);
        const pin = await open(refused);
        await until(() => pin.querySelector('[data-plan-pin-status="error"]') !== null, 'the refusal');
        expect(text(pin.querySelector('[data-plan-pin-status]'))).toBe('Could not read the pinned lines: no such commit');

        const nowhere = await mount(undefined, async () => ({ code: 'internal', message: 'no' }));
        expect((await open(nowhere)).querySelector('[data-plan-pin-status]')?.getAttribute('data-plan-pin-status')).toBe('nowhere');
    });
});

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** `mountLive` with the viewer's user id on it (#939). */
async function mountAs(path: string, h: LiveHarness, tree: JSXElement): Promise<HTMLDivElement> {
    setDataMode('live');
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(router);
    app.use(actorsPlugin({ transport: h.transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
    app.defineProvide(useActorDefs, clientDefs);
    app.defineProvide(useViewer, () => () => ({ workspaceId: USER, userId: USER, pending: false }));
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
        setDataMode('mock');
    });
    return container;
}

describe('the live Plan views as the signed-in user (#939)', () => {
    let h: LiveHarness;
    const PlanStore = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [PlanStore] });
    });
    afterEach(async () => {
        await h.stop();
    });

    const setUp = async () => {
        const forge = await h.agent('Forge', 'Manages the plan');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const project = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).projects()).find((p) => p.id === id)! as ProjectRecord;
        const store = h.app.as(owner).actor(PlanStore, planKey(WS, project.id));
        const plan = await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Mine to do' }, { title: 'Forge’s' }, { title: 'Open one' }] }] });
        const [mine, forges, open] = plan.phases[0]!.items as [PlanItem, PlanItem, PlanItem];
        await store.assign(mine.id, me, 0);
        await store.assign(forges.id, { kind: 'agent', agentId: forge }, 0);
        const second = await store.create({ title: 'Release' });
        const items = async (): Promise<PlanItem[]> => (await store.list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));
        return { forge, project, store, plan, second, mine, forges, open, items };
    };

    it('names You and the agents, and Mine keeps the viewer’s items', { timeout: 30_000 }, async () => {
        const { project, mine } = await setUp();
        const dom = await mountAs(`/projects/${project.id}/plan`, h, <PlanList project={project} />);
        await until(() => texts(dom.querySelectorAll('[data-plan-crew-name]')).includes('Forge'), 'Forge by name in the crew', 10_000);
        expect(texts(dom.querySelectorAll('[data-plan-crew-name]'))).toEqual(['Forge', 'You']);
        expect(text(dom.querySelector(`[data-plan-item="${mine.id}"] [data-plan-owner-name]`))).toBe('You');

        const segment = [...dom.querySelectorAll<HTMLButtonElement>('[data-plan-toolbar] button')].find((b) => text(b) === 'Mine')!;
        segment.click();
        await tick();
        expect(texts(dom.querySelectorAll('[data-plan-item-title]'))).toEqual(['Mine to do']);
    });

    it('the list has the plan switcher, and picking a plan follows ?plan=', { timeout: 30_000 }, async () => {
        const { project, second } = await setUp();
        const dom = await mountAs(`/projects/${project.id}/plan`, h, <PlanList project={project} />);
        await until(() => dom.querySelector('[data-plan-switcher]') !== null, 'the switcher', 10_000);
        expect(dom.querySelector('[data-plan-title]')?.textContent).toBe('Mobile pass');
        (dom.querySelector('[data-plan-switcher]') as HTMLElement).click();
        await tick();
        expect(texts(document.querySelectorAll('[data-plan-option]'))).toEqual(['Mobile pass', 'Release']);
        expect(document.querySelector<HTMLButtonElement>('[data-plan-new]')!.disabled).toBe(false);
        document.querySelector<HTMLButtonElement>(`[data-plan-option="${second.id}"]`)!.click();
        await until(() => dom.querySelector('[data-plan-title]')?.textContent === 'Release', 'the second plan', 10_000);
        expect(dom.querySelector('[data-plan-view-link="board"]')?.getAttribute('href')).toBe(`/projects/${project.id}/plan?view=board&plan=${second.id}`);
    });

    it('the board has the switcher, and a drop on You assigns the item to the viewer', { timeout: 30_000 }, async () => {
        const { project, open, items } = await setUp();
        const dom = await mountAs(`/projects/${project.id}/plan?view=board`, h, <PlanBoard project={project} />);
        const card = () => dom.querySelector<HTMLElement>(`[data-plan-card="${open.id}"]`);
        await until(() => card() !== null, 'the card on the board', 10_000);
        expect(dom.querySelector('[data-plan-switcher]')).not.toBeNull();
        expect(dom.querySelector('[data-plan-view-link="board"]')?.getAttribute('aria-current')).toBe('page');
        const key = async (k: string): Promise<void> => {
            card()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
            await tick();
        };
        await key(' ');
        await key('ArrowRight');
        await key('ArrowRight');
        await key(' ');
        await until(async () => {
            const a = (await items()).find((i) => i.id === open.id)!.assignee;
            return a?.kind === 'user' && a.userId === USER;
        }, 'the item assigned to the viewer', 10_000);
        expect(dom.querySelector('[data-plan-note]')).toBeNull();
    });

    it('the graph has the view toggle', { timeout: 30_000 }, async () => {
        const { project, plan } = await setUp();
        const dom = await mountAs(`/projects/${project.id}/plan?view=graph`, h, <PlanGraph project={project} />);
        await until(() => dom.querySelector('[data-plan-switcher-title]')?.textContent === 'Mobile pass', 'the plan in the switcher', 10_000);
        expect(dom.querySelector('[data-plan-view-link="graph"]')?.getAttribute('aria-current')).toBe('page');
        expect(dom.querySelector('[data-plan-view-link="list"]')?.getAttribute('href')).toBe(`/projects/${project.id}/plan?plan=${plan.id}`);
    });
});
