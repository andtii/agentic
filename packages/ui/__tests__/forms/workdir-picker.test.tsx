/**
 * The working-folder picker (#191): the chip label, the field, and the
 * controlled dialog — environment strip, top level, drilling and going up,
 * the breadcrumb, a pasted path inside and outside the roots, the states,
 * the new-worktree form and the footer.
 */
import { component, signal } from '@sigx/runtime-core';
import type { EnvironmentDescriptor, EnvironmentId, FsError, FsListResult, MachineId } from '@agentic/core';
import {
    WorkdirDialog,
    WorkdirField,
    fsErrorText,
    middleTruncate,
    toWorkdirEnvironment,
    workdirCrumbs,
    workdirLabel,
    type WorkdirEnvironment,
    type WorkdirRecent
} from '@agentic/ui';
import { buttonNamed, mount, tick } from '../helpers';
import { labelOf, setText } from './helpers';

const W = 'env_w' as EnvironmentId;
const L = 'env_l' as EnvironmentId;
const envs: WorkdirEnvironment[] = [
    {
        id: W,
        label: 'alien01 / work',
        os: 'windows',
        roots: ['C:\\Dev', 'D:\\src'],
        quota: { sourceId: 'q', runtime: 'claude-code', environmentId: W, availability: 'reported', windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', status: 'ok' }], observedAt: Date.now(), via: 'probe' }
    },
    { id: L, label: 'pi / home', os: 'linux', roots: ['/home/pi'], unavailable: 'Machine offline' }
];
const recent: WorkdirRecent[] = [
    { environmentId: W, path: 'C:\\Dev\\old', at: 1 },
    { environmentId: L, path: '/home/pi/elsewhere', at: 5 },
    { environmentId: W, path: 'C:\\Dev\\agentic\\branches\\47-drawer', at: 9 }
];

const list = (path: string, patch: Partial<FsListResult> = {}): FsListResult => ({ kind: 'list', path, entries: [], truncated: false, ...patch });
const agentic = list('C:\\Dev\\agentic', {
    parent: 'C:\\Dev',
    git: undefined,
    entries: [
        { name: 'main', path: 'C:\\Dev\\agentic\\main', git: { kind: 'repo', branch: 'main' } },
        { name: 'branches', path: 'C:\\Dev\\agentic\\branches' },
        { name: 'old', path: 'C:\\Dev\\agentic\\old', git: { kind: 'worktree', head: 'a1b2c3d' } }
    ]
});
const repo = list('C:\\Dev\\agentic\\main', { parent: 'C:\\Dev\\agentic', git: { kind: 'repo', branch: 'main' }, entries: [{ name: 'packages', path: 'C:\\Dev\\agentic\\main\\packages' }] });

interface State {
    open: boolean;
    environmentId: EnvironmentId | null;
    path: string | null;
    listing: FsListResult | null;
    loading: boolean;
    error: FsError | string | null;
    creating: boolean;
    worktreeError: FsError | string | null;
}

function picker(init: Partial<State> = {}) {
    const s = signal<State>({ open: true, environmentId: W, path: null, listing: null, loading: false, error: null, creating: false, worktreeError: null, ...init });
    const events: [string, unknown][] = [];
    const Host = component(() => () => (
        <WorkdirDialog
            model={() => s.open}
            environments={envs}
            recent={recent}
            environmentId={s.environmentId}
            path={s.path}
            listing={s.listing}
            loading={s.loading}
            error={s.error}
            creating={s.creating}
            worktreeError={s.worktreeError}
            onNavigate={(e) => events.push(['navigate', e])}
            onSelect={(e) => events.push(['select', e])}
            onCreateWorktree={(e) => events.push(['createWorktree', e])}
            onCancel={() => events.push(['cancel', undefined])}
        />
    ));
    const root = mount(<Host />);
    const part = (name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-scope="ag-workdir-picker"][data-part="${name}"]`);
    const parts = (name: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[data-scope="ag-workdir-picker"][data-part="${name}"]`)];
    const input = (label: string): HTMLInputElement => [...root.querySelectorAll<HTMLInputElement>('input')].find((i) => labelOf(i) === label)!;
    return { s, events, root, part, parts, input };
}

const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};

describe('workdirLabel', () => {
    it('shows the environment and the last two segments, the placeholder when unset', () => {
        expect(workdirLabel(null, envs)).toBe('Environment default (first root)');
        expect(workdirLabel(undefined, envs, 'Agent default')).toBe('Agent default');
        expect(workdirLabel({ environmentId: W, path: 'C:\\Dev\\agentic\\branches\\47-drawer' }, envs)).toBe('alien01 / work · …\\branches\\47-drawer');
        expect(workdirLabel({ environmentId: W, path: 'C:\\Dev' }, envs)).toBe('alien01 / work · C:\\Dev');
        expect(workdirLabel({ environmentId: L, path: '/home/pi/src/app' }, envs)).toBe('pi / home · …/src/app');
        // An environment the page no longer lists: its id, and the separator the path itself uses.
        expect(workdirLabel({ environmentId: 'env_x' as EnvironmentId, path: 'D:\\a\\b\\c' }, envs)).toBe('env_x · …\\b\\c');
    });

    it('middle-truncates, crumbs from the nearest root and maps error codes to words', () => {
        expect(middleTruncate('short')).toBe('short');
        const cut = middleTruncate('C:\\Dev\\agentic\\branches\\191-workdir-picker\\packages\\ui\\src', 30);
        expect(cut.length).toBe(30);
        expect(cut).toContain('…');
        expect(cut.endsWith('ui\\src')).toBe(true);
        expect(workdirCrumbs('c:/dev/agentic/main', envs[0]!)).toEqual([
            { label: 'C:\\Dev', path: 'C:\\Dev' },
            { label: 'agentic', path: 'C:\\Dev\\agentic' },
            { label: 'main', path: 'C:\\Dev\\agentic\\main' }
        ]);
        expect(workdirCrumbs('/home/pi', envs[1]!)).toEqual([{ label: '/home/pi', path: '/home/pi' }]);
        expect(fsErrorText({ code: 'outside-roots', message: 'x' })).toBe("That folder is outside this environment's working roots");
        expect(fsErrorText('Custom')).toBe('Custom');
        expect(fsErrorText(null)).toBeNull();
    });

    it('builds a browsable environment from a descriptor and its machine (environmentStatus)', () => {
        const env: EnvironmentDescriptor = {
            id: W,
            machineId: 'm_1' as MachineId,
            name: 'work',
            runtime: 'claude-code',
            account: { label: 'work', authStatus: 'ok' },
            cwdRoots: ['C:\\Dev'],
            concurrency: { max: 1, active: 1 },
            isolation: 'config-dir'
        };
        expect(toWorkdirEnvironment(env, { name: 'alien01', os: 'windows', online: true })).toEqual({ id: W, label: 'alien01 / work', os: 'windows', roots: ['C:\\Dev'] });
        expect(toWorkdirEnvironment(env, { name: 'alien01', os: 'windows', online: false }).unavailable).toBe('Machine offline');
        expect(toWorkdirEnvironment({ ...env, account: { label: 'work', authStatus: 'expired' } }, { name: 'a', os: 'linux', online: true }).unavailable).toBe('Sign-in expired');
    });
});

describe('WorkdirField', () => {
    const value = { environmentId: W, path: 'C:\\Dev\\agentic\\branches\\47-drawer' };

    it('labels the chip, keeps the full path in its title, and posts hidden inputs', () => {
        const events: string[] = [];
        const root = mount(<WorkdirField value={value} environments={envs} name="workdir" description="Where sessions start" onOpen={() => events.push('open')} onClear={() => events.push('clear')} />);
        const chip = root.querySelector<HTMLElement>('[data-scope="ag-workdir"][data-part="chip"]')!;
        expect(chip.tagName).toBe('OUTPUT');
        expect(chip.textContent).toBe('alien01 / work · …\\branches\\47-drawer');
        expect(chip.getAttribute('title')).toBe('alien01 / work · C:\\Dev\\agentic\\branches\\47-drawer');
        expect(labelOf(chip)).toBe('Working folder');
        expect(root.textContent).toContain('Where sessions start');
        const hidden = [...root.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((i) => [i.name, i.value]);
        expect(hidden).toEqual([['workdir.environmentId', W], ['workdir.path', value.path]]);
        buttonNamed(root, 'Change…').click();
        buttonNamed(root, 'Clear').click();
        expect(events).toEqual(['open', 'clear']);
    });

    it('shows the placeholder, no Clear and posts nothing when unset', () => {
        const root = mount(<WorkdirField value={null} environments={envs} name="workdir" label="Default folder" />);
        expect(root.querySelector('[data-part="chip"]')!.textContent).toBe('Environment default (first root)');
        expect(root.querySelector('[data-part="chip"]')!.hasAttribute('data-empty')).toBe(true);
        expect(root.querySelector('label')!.textContent).toBe('Default folder');
        expect(root.querySelectorAll('input[type="hidden"]').length).toBe(0);
        expect(() => buttonNamed(root, 'Clear')).toThrow();
    });

    it('renders the chip alone as the button when compact, and disables everything when disabled', () => {
        const events: string[] = [];
        const root = mount(<WorkdirField value={value} environments={envs} compact onOpen={() => events.push('open')} />);
        expect(root.querySelector('label')).toBeNull();
        const chip = root.querySelector<HTMLButtonElement>('button[data-scope="ag-workdir"][data-part="chip"]')!;
        expect(chip.getAttribute('aria-label')).toBe('Working folder: alien01 / work · …\\branches\\47-drawer');
        chip.click();
        expect(events).toEqual(['open']);
        const off = mount(<WorkdirField value={value} environments={envs} name="w" disabled />);
        expect(buttonNamed(off, 'Change…').disabled).toBe(true);
        for (const i of off.querySelectorAll<HTMLInputElement>('input[type="hidden"]')) expect(i.disabled).toBe(true);
    });
});

describe('WorkdirDialog', () => {
    it('is a plain dialog (not an alert) with the strip: the unavailable environment disabled with its reason in view', async () => {
        const p = picker({ environmentId: null });
        await tick();
        const popup = p.root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.getAttribute('role')).toBeNull();
        expect(popup.querySelector('[data-scope="dialog"][data-part="title"]')!.textContent).toBe('Choose a working folder');
        const [work, pi] = p.parts('env') as HTMLButtonElement[];
        expect(work!.disabled).toBe(false);
        expect(work!.getAttribute('aria-pressed')).toBe('false');
        expect(pi!.disabled).toBe(true);
        expect(pi!.textContent).toContain('pi / home');
        expect(pi!.textContent).toContain('Machine offline');
        expect(p.part('notice')!.textContent).toContain('Choose an environment');
        work!.click();
        expect(p.events).toEqual([['navigate', { environmentId: W, path: null }]]);
        p.s.environmentId = W;
        await tick();
        expect(p.parts('env')[0]!.getAttribute('aria-pressed')).toBe('true');
    });

    it('lists this environment\'s Recent (newest first) and its Roots at the top level; each navigates', async () => {
        const p = picker();
        await tick();
        const [recentSection, rootsSection] = p.parts('section');
        expect(recentSection!.querySelector('h3')!.textContent).toBe('Recent');
        const recents = [...recentSection!.querySelectorAll<HTMLButtonElement>('[data-part="shortcut"]')];
        expect(recents.map((b) => b.title)).toEqual(['C:\\Dev\\agentic\\branches\\47-drawer', 'C:\\Dev\\old']);
        expect(rootsSection!.querySelector('h3')!.textContent).toBe('Roots');
        const roots = [...rootsSection!.querySelectorAll<HTMLButtonElement>('[data-part="shortcut"]')];
        expect(roots.map((b) => b.textContent)).toEqual(['C:\\Dev', 'D:\\src']);
        recents[0]!.click();
        roots[1]!.click();
        expect(p.events).toEqual([
            ['navigate', { environmentId: W, path: 'C:\\Dev\\agentic\\branches\\47-drawer' }],
            ['navigate', { environmentId: W, path: 'D:\\src' }]
        ]);
        expect(buttonNamed(p.root, 'Use this folder').disabled).toBe(true);
    });

    it('shows each environment\'s usage limits in the strip, when it has them (#315)', async () => {
        const { parts } = picker();
        const [work, pi] = parts('env');
        expect(work!.querySelector('[data-scope="ag-quota"][data-part="used"]')!.textContent).toBe('76% used');
        expect(work!.querySelector('[data-scope="ag-quota"][data-part="root"]')!.hasAttribute('data-mod-compact')).toBe(true);
        expect(pi!.querySelector('[data-scope="ag-quota"]')).toBeNull();
    });

    it('explains an unavailable environment instead of browsing it', async () => {
        const p = picker({ environmentId: L });
        await tick();
        expect(p.part('notice')!.getAttribute('data-notice')).toBe('offline');
        expect(p.part('notice')!.textContent).toContain('Machine offline');
        expect(p.part('list')).toBeNull();
    });

    it('drills in with a click or Enter, moves with the arrows, and goes up with Backspace', async () => {
        const p = picker({ path: 'C:\\Dev\\agentic', listing: agentic });
        await tick();
        const listbox = p.part('list')!;
        expect(listbox.getAttribute('role')).toBe('listbox');
        const options = p.parts('item');
        expect(options.map((o) => o.getAttribute('role'))).toEqual(['option', 'option', 'option']);
        expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
        options[2]!.click();
        key(listbox, 'ArrowUp');
        await tick();
        expect(p.parts('item').map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
        expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
        key(listbox, 'ArrowUp');
        key(listbox, 'ArrowUp');
        await tick();
        expect(p.parts('item')[0]!.getAttribute('aria-selected')).toBe('true');
        key(listbox, 'ArrowDown');
        await tick();
        expect(p.parts('item')[1]!.getAttribute('aria-selected')).toBe('true');
        key(listbox, 'Home');
        key(listbox, 'End');
        key(listbox, 'Enter');
        key(listbox, 'Backspace');
        expect(p.events).toEqual([
            ['navigate', { environmentId: W, path: 'C:\\Dev\\agentic\\old' }],
            ['navigate', { environmentId: W, path: 'C:\\Dev\\agentic\\old' }],
            ['navigate', { environmentId: W, path: 'C:\\Dev' }]
        ]);
    });

    it('goes to the top level with Backspace at a root, and resets the highlight on a move', async () => {
        const p = picker({ path: 'C:\\Dev\\agentic', listing: agentic });
        await tick();
        key(p.part('list')!, 'ArrowDown');
        p.s.path = 'C:\\Dev';
        p.s.listing = list('C:\\Dev', { entries: [{ name: 'agentic', path: 'C:\\Dev\\agentic' }, { name: 'x', path: 'C:\\Dev\\x' }] });
        await tick();
        expect(p.parts('item')[0]!.getAttribute('aria-selected')).toBe('true');
        key(p.part('list')!, 'Backspace');
        expect(p.events).toEqual([['navigate', { environmentId: W, path: null }]]);
    });

    it('builds the breadcrumb from the root down, with All roots above it', async () => {
        const p = picker({ path: 'C:\\Dev\\agentic\\branches', listing: list('C:\\Dev\\agentic\\branches', { parent: 'C:\\Dev\\agentic' }) });
        await tick();
        const crumbs = p.parts('crumb') as HTMLButtonElement[];
        expect(crumbs.map((c) => c.textContent)).toEqual(['All roots', 'C:\\Dev', 'agentic', 'branches']);
        expect(crumbs[3]!.getAttribute('aria-current')).toBe('location');
        expect(p.part('crumbs')!.getAttribute('aria-label')).toBe('Folder path');
        crumbs[2]!.click();
        crumbs[1]!.click();
        crumbs[0]!.click();
        expect(p.events.map(([, e]) => (e as { path: string | null }).path)).toEqual(['C:\\Dev\\agentic', 'C:\\Dev', null]);
    });

    it('navigates to a pasted path inside the roots and refuses one outside with an inline error', async () => {
        const p = picker({ path: 'C:\\Dev', listing: list('C:\\Dev') });
        await tick();
        buttonNamed(p.root, 'Edit path').click();
        await tick();
        const field = p.input('Folder path');
        expect(field.value).toBe('C:\\Dev');
        for (const outside of ['E:\\secret', 'C:\\Dev2\\x', 'relative\\path']) {
            setText(p.input('Folder path'), outside);
            key(p.input('Folder path'), 'Enter');
            await tick();
            expect(p.root.querySelector('[data-scope="field"][data-part="error"]')!.textContent).toBe("That folder is outside this environment's working roots");
        }
        expect(p.events).toEqual([]);
        setText(p.input('Folder path'), 'd:/src/app/');
        key(p.input('Folder path'), 'Enter');
        await tick();
        expect(p.events).toEqual([['navigate', { environmentId: W, path: 'D:\\src\\app' }]]);
        // Leaving the editor brings the breadcrumb back.
        expect(p.part('editor')).toBeNull();
        expect(p.parts('crumb').length).toBeGreaterThan(1);
    });

    it('can open the path editor from the top level too', async () => {
        const p = picker();
        await tick();
        buttonNamed(p.root, 'Edit path').click();
        await tick();
        expect(p.input('Folder path').value).toBe('C:\\Dev');
        setText(p.input('Folder path'), 'C:\\Dev\\agentic');
        buttonNamed(p.root, 'Go').click();
        expect(p.events).toEqual([['navigate', { environmentId: W, path: 'C:\\Dev\\agentic' }]]);
    });

    it('shows a skeleton while the first listing loads, and dims the stale one on a move', async () => {
        const p = picker({ path: 'C:\\Dev\\agentic', loading: true });
        await tick();
        const skeleton = p.root.querySelector('[data-skeleton]')!;
        expect(skeleton.getAttribute('role')).toBe('status');
        expect(skeleton.textContent).toContain('Loading folders');
        p.s.listing = agentic;
        await tick();
        expect(p.part('list')!.hasAttribute('data-stale')).toBe(true);
        expect(p.part('root')!.hasAttribute('data-mod-loading')).toBe(true);
        expect(p.part('list')!.getAttribute('aria-busy')).toBe('true');
        expect(buttonNamed(p.root, 'Use this folder').disabled).toBe(true);
        p.parts('item')[0]!.click();
        expect(p.events).toEqual([]);
        p.s.loading = false;
        await tick();
        expect(p.part('list')!.hasAttribute('data-stale')).toBe(false);
        expect(buttonNamed(p.root, 'Use this folder').disabled).toBe(false);
    });

    it('never offers a listing for another folder as the one on screen', async () => {
        // The host cleared `loading` before swapping the listing in.
        const p = picker({ path: 'C:\\Dev\\agentic\\main', listing: agentic });
        await tick();
        expect(buttonNamed(p.root, 'Use this folder').disabled).toBe(true);
        // Same folder, another spelling: it is current (Windows paths fold case and separators).
        p.s.path = 'c:/dev/agentic';
        await tick();
        buttonNamed(p.root, 'Use this folder').click();
        expect(p.events).toEqual([['select', { environmentId: W, path: 'C:\\Dev\\agentic' }]]);
    });

    it('says when a folder has no subfolders, and when the listing is truncated', async () => {
        const p = picker({ path: 'C:\\Dev\\empty', listing: list('C:\\Dev\\empty', { parent: 'C:\\Dev' }) });
        await tick();
        expect(p.part('notice')!.textContent).toBe('No subfolders');
        expect(p.part('list')).toBeNull();
        p.s.listing = { ...agentic, truncated: true };
        p.s.path = agentic.path;
        await tick();
        expect(p.part('notice')!.getAttribute('data-notice')).toBe('truncated');
        expect(p.part('notice')!.textContent).toBe('Showing the first 500 folders');
    });

    it.each([
        [{ code: 'outside-roots', message: 'x' } as FsError, "That folder is outside this environment's working roots"],
        [{ code: 'not-found', message: 'x' } as FsError, "That folder doesn't exist on the machine"],
        [{ code: 'timeout', message: 'x' } as FsError, "The machine didn't answer"],
        [{ code: 'unknown-environment', message: 'x' } as FsError, "This environment isn't on the machine any more"],
        [{ code: 'unsupported', message: 'x' } as FsError, "The machine's daemon can't do this yet — update it"],
        [{ code: 'internal', message: 'x' } as FsError, 'The machine hit an error while reading the folder'],
        ['The daemon went away', 'The daemon went away']
    ])('shows the error %j as plain text with a retry', async (error, text) => {
        const p = picker({ path: 'C:\\Dev\\gone', listing: agentic, error });
        await tick();
        const notice = p.part('notice')!;
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.textContent).toContain(text);
        expect(p.part('list')).toBeNull();
        expect(buttonNamed(p.root, 'Use this folder').disabled).toBe(true);
        buttonNamed(p.root, 'Try again').click();
        expect(p.events).toEqual([['navigate', { environmentId: W, path: 'C:\\Dev\\gone' }]]);
    });

    it('badges repos and worktrees with their branch, or the short head when detached', async () => {
        const p = picker({ path: repo.path, listing: { ...repo, entries: agentic.entries } });
        await tick();
        const badges = p.parts('item').map((o) => o.querySelector('[data-scope="ag-pill"]')?.textContent ?? null);
        expect(badges).toEqual(['repo · main', null, 'worktree · detached a1b2c3d']);
        // The folder's own badge sits in the header.
        expect(p.part('bar')!.querySelector('[data-scope="ag-pill"]')!.textContent).toBe('repo · main');
    });

    it('offers New worktree… only on a repo or worktree, and emits the request with the suggested path following the branch', async () => {
        const plain = picker({ path: agentic.path, listing: agentic });
        await tick();
        expect(() => buttonNamed(plain.root, 'New worktree…')).toThrow();

        const p = picker({ path: repo.path, listing: repo });
        await tick();
        buttonNamed(p.root, 'New worktree…').click();
        await tick();
        expect(p.part('worktree')!.getAttribute('aria-label')).toBe('New worktree');
        expect(p.input('Base').value).toBe('main');
        expect(p.input('Target path').value).toBe('');
        setText(p.input('Branch'), 'feat/47 drawer');
        await tick();
        buttonNamed(p.root, 'Create worktree').click();
        await tick();
        expect(p.root.textContent).toContain('A branch name has no spaces');
        expect(p.events).toEqual([]);

        setText(p.input('Branch'), '47-drawer');
        await tick();
        expect(p.input('Target path').value).toBe('C:\\Dev\\agentic\\branches\\47-drawer');
        setText(p.input('Branch'), 'feat/48');
        await tick();
        expect(p.input('Target path').value).toBe('C:\\Dev\\agentic\\branches\\feat-48');
        key(p.input('Branch'), 'Enter');
        expect(p.events).toEqual([['createWorktree', { environmentId: W, repo: 'C:\\Dev\\agentic\\main', branch: 'feat/48', base: 'main', path: 'C:\\Dev\\agentic\\branches\\feat-48' }]]);

        // An edited target stops following the branch, and must stay inside the roots.
        setText(p.input('Target path'), 'E:\\elsewhere');
        setText(p.input('Branch'), 'feat/49');
        await tick();
        expect(p.input('Target path').value).toBe('E:\\elsewhere');
        buttonNamed(p.root, 'Create worktree').click();
        await tick();
        expect(p.root.textContent).toContain("The worktree must go inside this environment's working roots");
        setText(p.input('Target path'), 'D:\\src\\wt');
        setText(p.input('Base'), '');
        buttonNamed(p.root, 'Create worktree').click();
        expect(p.events[1]).toEqual(['createWorktree', { environmentId: W, repo: 'C:\\Dev\\agentic\\main', branch: 'feat/49', path: 'D:\\src\\wt' }]);
    });

    it('shows the request in flight and its error; a move closes the form', async () => {
        const p = picker({ path: repo.path, listing: repo });
        await tick();
        buttonNamed(p.root, 'New worktree…').click();
        p.s.creating = true;
        await tick();
        const create = buttonNamed(p.root, 'Create worktree');
        expect(create.disabled).toBe(true);
        expect(create.getAttribute('aria-busy')).toBe('true');
        p.s.creating = false;
        p.s.worktreeError = { code: 'branch-exists', message: 'fatal: a branch named x already exists' };
        await tick();
        expect(p.part('worktree')!.querySelector('[role="alert"]')!.textContent).toBe('A branch with that name already exists');
        p.s.path = 'C:\\Dev\\agentic\\branches\\x';
        p.s.listing = list('C:\\Dev\\agentic\\branches\\x', { parent: 'C:\\Dev\\agentic\\branches', git: { kind: 'worktree', branch: 'x' } });
        await tick();
        expect(p.part('worktree')).toBeNull();
    });

    it('selects the listed folder and closes; Cancel and Escape emit cancel', async () => {
        const p = picker({ path: agentic.path, listing: agentic });
        await tick();
        buttonNamed(p.root, 'Use this folder').click();
        await tick();
        expect(p.events).toEqual([['select', { environmentId: W, path: 'C:\\Dev\\agentic' }]]);
        expect(p.s.open).toBe(false);

        p.s.open = true;
        await tick();
        buttonNamed(p.root, 'Cancel').click();
        await tick();
        expect(p.events.slice(1)).toEqual([['cancel', undefined]]);
        expect(p.s.open).toBe(false);

        // Any other close (Escape, the backdrop) is a cancel too.
        p.s.open = true;
        await tick();
        p.root.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
        await tick();
        expect(p.s.open).toBe(false);
        expect(p.events.slice(1)).toEqual([['cancel', undefined], ['cancel', undefined]]);
    });

    it('never posts into a surrounding form: no form elements, no named controls', async () => {
        const p = picker({ path: repo.path, listing: repo });
        await tick();
        buttonNamed(p.root, 'New worktree…').click();
        buttonNamed(p.root, 'Edit path').click();
        await tick();
        expect(p.root.querySelector('form')).toBeNull();
        expect(p.root.querySelectorAll('[name]').length).toBe(0);
    });
});
