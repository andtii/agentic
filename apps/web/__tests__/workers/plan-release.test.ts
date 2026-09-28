/**
 * A plan item done or dropped reaches the project features on the real host (#1081): the app's Plan actor is built
 * with the router release port, so marking an item done — nothing else calling — has the router run the git feature's
 * `onPlanItemReleased` on the project's online folder: the daemon is asked to remove `plan/<project>-<n>`'s worktree,
 * and the call is audited `project.item-released`. A dropped item goes the same way.
 */
import { SELF } from 'cloudflare:test';
import { projectFolderKey, type EnvironmentId, type MachineId, type WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { GIT_FEATURE_ID } from '@agentic/plugins-git';
import { AuditActor, auditKey, defineMachineActor, definePlanActor, machineKey, planKey, Workspace, workspaceKey } from '@agentic/platform';
import { overHttp, signIn } from './http';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_plan_release';
const WS = userId as WorkspaceId;
const E1 = 'env_release' as EnvironmentId;
/** Definitions for `overHttp` — only their `type` matters on the wire; the host runs the app's own. */
const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });
const Plan = definePlanActor();

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

interface Frame {
    readonly t: string;
    readonly requestId?: string;
    readonly environmentId?: string;
    readonly op?: { readonly kind: string; readonly repo?: string; readonly path?: string; readonly branch?: string };
}

/** A paired machine's daemon on a real socket, reporting E1 (root `/work`); it answers `worktree-remove` as removed. */
async function onlineDaemon(machineId: MachineId, token: string): Promise<{ ws: WebSocket; removes: Frame[] }> {
    const response = await SELF.fetch(`${ORIGIN}/_agentic/daemon/${machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } });
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket, got HTTP ${response.status}`);
    ws.accept();
    const removes: Frame[] = [];
    ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.t !== 'fs.request' || frame.op?.kind !== 'worktree-remove') return;
        removes.push(frame);
        ws.send(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'fs.response', requestId: frame.requestId, result: { kind: 'worktree-remove', path: frame.op.path, removed: true, branchDeleted: false } }));
    });
    ws.send(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.0.0-test', os: 'linux', environments: [inMemoryEnvironment(machineId, E1)], capabilities: [IN_MEMORY_CAPABILITIES], resume: {} }));
    return { ws, removes };
}

describe('worker: a finished plan item is released to the project features', () => {
    it('PRJ-11: an item done, then one dropped — the git feature removes each worktree on the online folder, audited', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(WS), cookie);
        const { machineId, pairingCode } = await workspace.registerMachinePending({ name: 'laptop' });
        const machine = overHttp(Machine, machineKey(WS, machineId), cookie);
        const { token } = await machine.pair(pairingCode, { name: 'laptop' });
        const daemon = await onlineDaemon(machineId, token);
        await until(async () => (await machine.get()).online, 'the machine online');

        const project = await workspace.upsertProject({
            name: 'Agentic',
            folders: { [projectFolderKey(machineId, E1)]: '/work/agentic' },
            features: { [GIT_FEATURE_ID]: { worktreePerChat: true, worktreeCleanup: 'on-chat-leave' } }
        });
        const plan = overHttp(Plan, planKey(WS, project.id), cookie);
        await plan.create({ title: 'Ship', phases: [{ title: 'One', items: [{ title: 'store' }, { title: 'tools' }] }] });

        await plan.update(1, { state: 'done' });
        await until(() => daemon.removes.length === 1, 'the worktree of #1 to be removed');
        await plan.update(2, { state: 'dropped', note: 'not needed' });
        await until(() => daemon.removes.length === 2, 'the worktree of #2 to be removed');
        expect(daemon.removes.map((f) => ({ environmentId: f.environmentId, repo: f.op?.repo, branch: f.op?.branch }))).toEqual([
            { environmentId: E1, repo: '/work/agentic', branch: 'plan/agentic-1' },
            { environmentId: E1, repo: '/work/agentic', branch: 'plan/agentic-2' }
        ]);

        const audit = overHttp(AuditActor, auditKey(WS), cookie);
        const records = async () => (await audit.list({ kinds: ['project.item-released'] })).events.map((e) => e.data as { planItem: number; reason: string; outcome?: string });
        await until(async () => (await records()).length === 2, 'both releases audited');
        expect((await records()).map((d) => [d.planItem, d.reason, d.outcome?.startsWith('removed ')]).sort()).toEqual([
            [1, 'done', true],
            [2, 'dropped', true]
        ]);
        daemon.ws.close(1000, 'bye');
    });
});
