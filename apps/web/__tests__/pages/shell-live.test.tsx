/**
 * The shell on live data (#151): the sidebar's Home badge is the "Needs you"
 * count — the same rows Home lists, over the real wire — and a signed-in
 * user has a sign-out control. The mock shell keeps the design workspace's
 * three and draws no sign-out.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import type { MessageId, TaskId } from '@agentic/core';
import { AgentActor, TaskActor, Workspace, agentKey, taskKey, workspaceKey } from '@agentic/platform';
import { installThemes } from '@agentic/ui/design-system';
import { App } from '../../src/App';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, mountAt, tick } from './helpers';

// The sidebar foot asks which sign-in doors are open (#143) through a serverFn; outside a build it carries no
// `__sigxKey`, so the test answers for it: no doors — these tests sign in through the harness.
vi.mock('../../src/api/sign-in.server', () => ({
    signInOptions: Object.assign(async () => ({ github: false, devLogin: false }), { __sigxKey: 'test:signInOptions' })
}));

// `App` links the font stylesheet in <head>; happy-dom would go and fetch it.
const domSettings = () => (window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings;
let before: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } | null = null;
beforeAll(() => {
    // As both entries do: the shell asks the design system's `md` breakpoint.
    installThemes();
    const settings = domSettings();
    before = { disableCSSFileLoading: settings.disableCSSFileLoading, handleDisabledFileLoadingAsSuccess: settings.handleDisabledFileLoadingAsSuccess };
    settings.disableCSSFileLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
});
afterAll(() => {
    if (before) Object.assign(domSettings(), before);
});

let h: LiveHarness | null = null;
afterEach(async () => {
    await h?.stop();
    h = null;
});

const badge = (dom: ParentNode): string | null => dom.querySelector('[data-scope="ai-shell"][data-part="badge"]')?.textContent ?? null;
const card = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-home-needs] [data-scope="ai-approval"][data-part="root"]');
const signOut = (dom: ParentNode) => dom.querySelector<HTMLFormElement>('form[data-user-signout]');

describe('the shell (live)', () => {
    it('the Home badge counts the open "Needs you" rows: 1 for a raised approval, none once it is answered', async () => {
        h = await startLive({ respond: () => [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }] });
        const dom = await mountLive('/', h, <App />);
        await tick();
        expect(badge(dom)).toBeNull();

        const forge = await h.agent('Forge', 'Builds things');
        await h.app.as(owner).actor(AgentActor, agentKey(WS, forge)).update({ tools: [{ name: 'push' }], approvalPolicy: [{ id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }] }, 'ask on destructive');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const taskId = 't_push' as TaskId;
        await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: 'push it', origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
        await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);

        await until(() => badge(dom) === '1', 'the badge to count the approval');
        await until(() => card(dom) !== null, 'the approval card on Home');
        buttonNamed(card(dom)!, 'Allow once').click();
        await until(() => badge(dom) === null, 'the badge to clear');
    });

    it('a signed-in user can sign out: a plain form posting to /auth/logout', async () => {
        h = await startLive();
        const dom = await mountLive('/', h, <App />);
        await until(() => signOut(dom) !== null, 'the sign-out form');
        const form = signOut(dom)!;
        expect(form.getAttribute('method')).toBe('post');
        expect(form.getAttribute('action')).toBe('/auth/logout');
        expect(buttonNamed(form, 'Sign out').getAttribute('type')).toBe('submit');
    });
});

describe('the shell (mock)', () => {
    it('keeps the design workspace: three need you, nobody to sign out', async () => {
        const dom = await mountAt('/', <App />);
        await tick();
        expect(badge(dom)).toBe('3');
        expect(signOut(dom)).toBeNull();
    });
});
