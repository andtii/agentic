/**
 * The Changes and Files views on the platform (#564): a paired Machine whose
 * socket answers `fs.request` the way the in-memory daemon does
 * (`answerFilesOp` over `IN_MEMORY_SESSION_FOLDERS`), read through the page's
 * own wiring — `liveSessionFiles` → `machineWorkspaceSource` over the actor
 * client on the wire — and drawn by the real views.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { actorsPlugin } from '@sigx/actors/app';
import type { EnvironmentDescriptor, EnvironmentId, MachineId, SessionId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, IN_MEMORY_PROJECT_ROOT, IN_MEMORY_SESSION_FOLDERS, answerFilesOp, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey, type SessionInfo } from '@agentic/platform';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { clientDefs } from '../../src/actors/client';
import { createServerRouter } from '../../src/router';
import { ChangesView } from '../../src/pages/SessionChanges';
import { FilesView } from '../../src/pages/SessionFiles';
import { changesHref, filesHref } from '../../src/pages/session/files';
import { liveSessionFiles, machineClientFor } from '../../src/pages/session/files-sources';
import { loadSession, agentNamed } from '../../src/mock/workspace';
import { WS, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; environmentId?: string; op?: Parameters<typeof answerFilesOp>[2] };

const V = DAEMON_PROTOCOL_VERSION;
const ENV = 'env_work' as EnvironmentId;
let h: LiveHarness;
let answer: (key: string, frame: Frame) => void = () => undefined;
const Machine = defineMachineActor({
    socket: {
        send: (key, text) => {
            const frame = JSON.parse(text) as Frame;
            if (frame.t === 'fs.request') setTimeout(() => answer(key, frame), 0);
            return true;
        },
        close: () => undefined
    }
});

beforeEach(async () => {
    h = await startLive(undefined, { actors: [Machine] });
});
const closers: (() => void)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) close();
    await h.stop();
});

const environment = (machineId: MachineId): EnvironmentDescriptor => ({ ...inMemoryEnvironment(machineId, ENV), runtime: 'claude-code', cwdRoots: ['/work'] });

/** A machine paired and online, whose daemon has the `files` feature and answers from the in-memory folders. */
async function pairedMachine() {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'alien01' });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name: 'alien01', os: 'linux', daemonVersion: '0.1.5-test' });
    const env = environment(machineId);
    answer = (_key, frame) => {
        const out = answerFilesOp(IN_MEMORY_SESSION_FOLDERS, env, frame.op!);
        void daemon.socketMessage(JSON.stringify({ v: V, t: 'fs.response', requestId: frame.requestId, ...out }));
    };
    await daemon.socketMessage(JSON.stringify({ v: V, t: 'hello', machineId, daemonVersion: '0.1.5-test', os: 'linux', environments: [env], capabilities: [{ ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' }], resume: {}, features: ['files'] }));
    const view = await h.app.as(owner).actor(Machine, machineKey(WS, machineId)).get();
    return { machineId, view };
}

async function mount(kind: 'changes' | 'files', files: NonNullable<ReturnType<typeof liveSessionFiles>>, path: string): Promise<HTMLDivElement> {
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const v = loadSession('s1')!;
    const ctx = { v, agent: agentNamed(v.agentId), files };
    const app = defineApp(kind === 'changes' ? <ChangesView ctx={ctx} /> : <FilesView ctx={ctx} />);
    app.use(router);
    app.use(actorsPlugin({ transport: h.transport }));
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

const info = (machineId: MachineId, cwd = IN_MEMORY_PROJECT_ROOT) => ({ opened: true, spec: { machineId, environmentId: ENV, cwd, agentId: 'forge' } }) as unknown as SessionInfo;

describe('session files on the platform (#564)', () => {
    it('offers Files and Changes only when the daemon has the files feature and the session a folder', async () => {
        const { machineId, view } = await pairedMachine();
        expect(view.features).toContain('files');
        const client = machineClientFor(clientDefs(), WS);
        expect(liveSessionFiles('s1', info(machineId), view, client)!.files).toBe(true);
        expect(liveSessionFiles('s1', info(machineId), { ...view, features: [] }, client)!.files).toBe(false);
        expect(liveSessionFiles('s1', { opened: true, spec: { agentId: 'atlas' } } as unknown as SessionInfo, undefined, client)!.files).toBe(false);
    });

    it('Changes reads the change set and the diff through the Machine', { timeout: 15_000 }, async () => {
        const { machineId, view } = await pairedMachine();
        const files = liveSessionFiles('s1' as SessionId, info(machineId), view, machineClientFor(clientDefs(), WS), { base: 'main' })!;
        const dom = await mount('changes', files, changesHref('s1', { file: 'src/app.ts' }));
        await until(() => dom.querySelectorAll('[data-scope="ag-changes"][data-part="item"]').length > 0, 'the change list');
        expect(texts(dom.querySelectorAll('[data-scope="ag-changes"][data-part="item"] [data-part="name"]'))).toContain('app.ts');
        expect(dom.querySelector('[data-scope="ag-session-bar"][data-part="branch"]')!.textContent).toBe('feature/files');
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="diff"]') !== null, 'the diff');
        const diff = dom.querySelector('[data-scope="ag-code"][data-kind="diff"]')!.textContent!;
        expect(diff).toContain('answer = 41');
        expect(diff).toContain('answer = 42');
    });

    it('Files lists the folder without ignored entries and reads a file', { timeout: 15_000 }, async () => {
        const { machineId, view } = await pairedMachine();
        const files = liveSessionFiles('s1', info(machineId), view, machineClientFor(clientDefs(), WS))!;
        const dom = await mount('files', files, filesHref('s1', 'src/app.ts'));
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="viewer"]') !== null, 'the viewer');
        const paths = [...dom.querySelectorAll<HTMLElement>('[data-scope="ag-file-tree"][data-part="item"]')].map((i) => i.dataset['path']);
        expect(paths).toEqual(expect.arrayContaining(['README.md', 'src', 'src/app.ts']));
        expect(paths).not.toContain('dist');
        expect(dom.querySelector('[data-scope="ag-code"][data-kind="viewer"]')!.textContent).toContain('export const answer = 42;');
    });
});
