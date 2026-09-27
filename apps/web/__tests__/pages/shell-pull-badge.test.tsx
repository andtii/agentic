/**
 * The Home badge counts the pull requests whose move is yours (#967): Home lists them in "Needs you" (#865), so the
 * shell's badge is the same "N open" — on mock data (the Work fixtures) and live, where the shell reads every Git
 * project's Pulls actor itself, so the badge holds on any page, not only on Home.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { projectFolderKey, type EnvironmentDescriptor, type EnvironmentId, type PullRequest } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, definePullsActor, defineRegistry, machineKey, pullsKey, registryKey, workspaceKey, type PullSource } from '@agentic/platform';
import { gitFeatureManifest } from '@agentic/plugins-git';
import { installThemes } from '@agentic/ui/design-system';
import { App } from '../../src/App';
import { clientDefs } from '../../src/actors/client';
import { GIT_FEATURE_ID } from '../../src/pages/projects/features/git/model';
import { saveProjectWith } from '../../src/pages/projects/live';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { mountAt, tick } from './helpers';

vi.mock('../../src/api/sign-in.server', () => ({
    signInOptions: Object.assign(async () => ({ github: false, devLogin: false }), { __sigxKey: 'test:signInOptions' })
}));

const domSettings = () => (window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings;
let before: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } | null = null;
beforeAll(() => {
    installThemes();
    const settings = domSettings();
    before = { disableCSSFileLoading: settings.disableCSSFileLoading, handleDisabledFileLoadingAsSuccess: settings.handleDisabledFileLoadingAsSuccess };
    settings.disableCSSFileLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
});
afterAll(() => {
    if (before) Object.assign(domSettings(), before);
});

const badge = (dom: ParentNode): string | null => dom.querySelector('[data-scope="nav-list"] [data-scope="badge"]')?.textContent ?? null;

describe('the Home badge and pull requests (mock)', () => {
    it('counts every "Needs you" row, the pull requests whose move is yours included: the badge is Home\'s "N open"', async () => {
        const dom = await mountAt('/', <App />);
        await tick();
        const rows = dom.querySelectorAll('[data-home-needs] [data-needs-row]').length;
        const prs = dom.querySelectorAll('[data-home-needs] [data-needs-pull]').length;
        expect(prs).toBeGreaterThan(0);
        expect(badge(dom)).toBe(String(rows));
        expect(dom.querySelector('[data-home-needs]')?.textContent).toContain(`${rows} open`);
    });
});

describe('the Home badge and pull requests (live)', () => {
    let h: LiveHarness | null = null;
    afterEach(async () => {
        await h?.stop();
        h = null;
    });

    const ready: PullRequest = {
        provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
        head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
        checks: [{ name: 'test', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
    };
    const running: PullRequest = { ...ready, number: 603, title: 'still running', checks: [{ name: 'test', state: 'running' }], review: { state: 'none', reviewers: [], threads: [] }, mergeable: undefined };

    it('a ready PR in a Git project lifts the badge on any page; a PR agents still work on does not', { timeout: 20_000 }, async () => {
        const source: PullSource = { get: async (_repo, n) => [ready, running].find((pr) => pr.number === n), listOpen: async () => [ready, running] };
        const Pulls = definePullsActor({ sources: { open: () => source } });
        const Registry = defineRegistry({ catalogue: [gitFeatureManifest] });
        h = await startLive(undefined, { actors: [Pulls, Registry] });
        await h.app.as(owner).actor(Registry, registryKey(WS)).enable(GIT_FEATURE_ID);
        const forge = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        // Git needs a folder, and a folder a paired machine.
        const { machineId, pairingCode } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
        const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
        await daemon.pair(pairingCode, { name: 'laptop', os: 'windows', daemonVersion: '0.1.0-test' });
        const env: EnvironmentDescriptor = { ...inMemoryEnvironment(machineId, 'env_win' as EnvironmentId), name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus: 'ok' }, cwdRoots: ['C:/Dev'], isolation: 'config-dir' };
        await daemon.socketMessage(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments: [env], capabilities: [{ ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' }], resume: {} }));

        const dom = await mountLive('/agents', h, <App />);
        await tick();
        expect(badge(dom)).toBeNull();

        const { id } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: { [projectFolderKey(machineId)]: 'C:/Dev/agentic' }, connectors: [], features: { [GIT_FEATURE_ID]: {} } });
        await h.app.as(owner).actor(Pulls, pullsKey(WS, id)).watch({ provider: 'github', repo: 'andtii/agentic' });
        await until(() => badge(dom) === '1', 'the badge to count the ready PR');
    });
});
