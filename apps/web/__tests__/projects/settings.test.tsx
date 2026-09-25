/**
 * Settings › General, Members, Folders and Connectors and the New project dialog (#733) on mock data: each tab shows
 * its part of the record and saves only that part (`mockSettingsSaves`); the folder rows keep Browse, the git badge,
 * the overrides per environment and the acme note (#702); `/projects/new` is the dialog over the index, prefilled
 * from a folder (#336), with its Project manager step and the `pm` spec on the create. The old project form (#333) is
 * still covered below until X2 removes it. #733 owns this file.
 */
import { describe, it, expect } from 'vitest';
import { MEMBER_LIMIT_MAX, PM_PERSONALITIES, type ProjectFeaturePlugin, type ProjectPatch } from '@agentic/core';
import { AGENTS, PROJECTS } from '../../src/mock/workspace';
import { AGENTIC_ORIGIN, mockFsLocate } from '../../src/mock/fs';
import { opsPlugins } from '../../src/mock/ops';
import { mockSettingsSaves } from '../../src/mock/projects/settings';
import { mockLocate } from '../../src/pages/projects/locate';
import { blankNewProject, newProjectPatchOf, PERSONALITY_SAMPLES, suggestedPmName } from '../../src/pages/projects/new/model';
import { NewProjectDialog } from '../../src/pages/projects/new/NewProjectDialog';
import { tabPatchOf } from '../../src/pages/projects/settings/general/TabFrame';
import { membersPatchOf } from '../../src/pages/projects/settings/members/Members';
import { connectorOptionsOf, featureManifestsOf, projectDraftOf } from '../../src/pages/projects/model';
import { ProjectForm } from '../../src/pages/projects/ProjectForm';
import { mockWorkdirEnvironments } from '../../src/pages/workdir/environments';
import { mountAt, setText, text } from '../pages/helpers';
import { mountRoute, page, texts } from '../pages/mount';

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
/** A machine's folder row (#702); `override` is one environment's row inside it. */
const row = (dom: ParentNode, machine: string): HTMLElement => dom.querySelector<HTMLElement>(`[data-project-folder="${machine}"]`)!;
const override = (dom: ParentNode, machine: string, env: string): HTMLElement => row(dom, machine).querySelector<HTMLElement>(`[data-project-override="${env}"]`)!;
const chip = (el: ParentNode): string => text(el.querySelector('[data-scope="ag-workdir"][data-part="chip"]'));
const openOverrides = async (dom: ParentNode, machine: string): Promise<void> => {
    row(dom, machine).querySelector<HTMLButtonElement>('[data-project-override-open]')!.click();
    await settle();
};
const openPopup = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && !x.disabled);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};

/** Browse: open the row's picker (a machine's, or an `override` row), walk `path` from the root shortcut, use the folder. */
async function browse(at: HTMLElement, root: string, ...names: string[]): Promise<void> {
    buttonIn(at, 'Change…').click();
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-scope="ag-workdir-picker"][data-part="root"]')!;
    // A row with a folder opens inside it: back to the top level (Recent + Roots) first.
    if (!dialog.querySelector('[data-part="shortcut"]')) {
        [...dialog.querySelectorAll<HTMLButtonElement>('[data-part="crumb"]')].find((b) => b.textContent?.trim() === 'All roots')!.click();
        await settle();
    }
    [...dialog.querySelectorAll<HTMLButtonElement>('[data-part="shortcut"]')].find((b) => b.title === root)!.click();
    await settle();
    for (const name of names) {
        [...dialog.querySelectorAll<HTMLElement>('[data-part="item"]')].find((i) => i.querySelector('[data-part="name"]')?.textContent === name)!.click();
        await settle();
    }
    buttonIn(openPopup(), 'Use this folder').click();
    await settle();
}

/** The last patch a settings tab saved on mock data. */
const lastSave = (): ProjectPatch | undefined => mockSettingsSaves[mockSettingsSaves.length - 1];
const save = async (dom: ParentNode): Promise<void> => {
    buttonIn(dom, 'Save').click();
    await settle();
};
const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-new-project]')!;
const dialogForm = (): HTMLElement => dialog().closest('form')!;

describe('Settings › General (mock)', () => {
    it('shows the name, description and colour; a save sends only them; no name keeps it here; Delete asks first', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/general');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="general"]')!;
        expect(tab.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        expect(tab.querySelector<HTMLTextAreaElement>('textarea[name="project-description"]')!.value).toBe('The Unified Agent Platform monorepo.');
        expect(tab.querySelector('[data-project-folder]')).toBeNull();
        setText(tab.querySelector<HTMLInputElement>('input[name="project-name"]')!, '  ');
        await save(tab);
        expect(mockSettingsSaves).toEqual([]);
        expect(text(tab.querySelector('[data-scope="field"][data-part="error"]'))).toBe('A name is required.');
        setText(tab.querySelector<HTMLInputElement>('input[name="project-name"]')!, ' agentic 2 ');
        setText(tab.querySelector<HTMLTextAreaElement>('textarea[name="project-description"]')!, '');
        await save(tab);
        expect(lastSave()).toEqual({ id: 'p_agentic', name: 'agentic 2', description: null });
        expect(text(tab.querySelector('[data-project-saved]'))).toBe('Saved.');
        buttonIn(tab, 'Delete project').click();
        await settle();
        expect(text(document.body)).toContain('Delete agentic?');
    });
});

describe('Settings › Members (mock)', () => {
    it('the member cards with the coordinator as project manager, a role and a limit per member; a save sends the members', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/members');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="members"]')!;
        expect([...tab.querySelectorAll('[data-project-member]')].map((r) => r.getAttribute('data-project-member'))).toEqual(['forge', 'lint', 'atlas']);
        expect(text(tab.querySelector('[data-project-coordinator]'))).toContain('Atlas is the project manager');
        expect(tab.querySelector('input[name="member-limit-forge"]')).not.toBeNull();
        setText(tab.querySelector<HTMLInputElement>('input[name="member-role-forge"]')!, ' Developer ');
        await settle();
        await save(tab);
        expect(lastSave()).toEqual({ id: 'p_agentic', members: { agentIds: ['forge', 'lint', 'atlas'], coordinator: 'atlas', roles: { forge: 'Developer' }, limits: {} } });
        // Dropping the coordinator from the roster drops it as project manager.
        const box = tab.querySelector<HTMLInputElement>('[data-new-chat-agent="atlas"] input[name="member"]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(tab.querySelector('[data-project-coordinator]')).toBeNull();
        expect(tab.querySelector('[data-project-member="atlas"]')).toBeNull();
    });

    it('membersPatchOf keeps roles and limits of members only, limits whole and at most the max', () => {
        expect(membersPatchOf({ picked: ['forge', 'lint', 'forge'], coordinator: 'scout', roles: { forge: ' Dev ', scout: 'PM', lint: '  ' }, limits: { forge: 3, lint: 40, scout: 2 } })).toEqual({
            agentIds: ['forge', 'lint'], coordinator: null, roles: { forge: 'Dev' }, limits: { forge: 3, lint: MEMBER_LIMIT_MAX }
        });
        expect(membersPatchOf({ picked: ['forge'], coordinator: 'forge', roles: {}, limits: { forge: 1.5 } }).limits).toEqual({});
    });
});

describe('Settings › Folders (mock)', () => {
    it('one row per machine with its overrides (#702); Browse keeps the badge, Find opens on an override, a save sends the folders', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/folders');
        expect([...dom.querySelectorAll('[data-project-folder]')].map((r) => r.getAttribute('data-project-folder'))).toEqual(['alien01', 'nuc-lab']);
        expect(chip(row(dom, 'alien01'))).toContain('agentic');
        expect(chip(override(dom, 'alien01', 'env_alien01_personal'))).toContain('agentic');
        expect(chip(override(dom, 'alien01', 'env_alien01_codex'))).toContain("The machine's folder");
        expect(text(override(dom, 'alien01', 'env_alien01_client_acme'))).toContain("outside this environment's folders");
        expect(chip(row(dom, 'nuc-lab'))).toContain('No folder on this machine');
        // A stored folder has no badge, so no origin and no Find yet; Browse brings the badge back.
        expect([...dom.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.trim() === 'Find')).toBe(false);
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'agentic', 'main');
        expect(texts([...row(dom, 'alien01').querySelectorAll('[data-project-folder-meta] [data-scope="badge"][data-part="root"]')])).toEqual(['repo · main']);
        buttonIn(override(dom, 'alien01', 'env_alien01_codex'), 'Find').click();
        await settle();
        expect(openPopup().querySelector('[data-project-locate="error"]')).not.toBeNull();
        buttonIn(openPopup(), 'Cancel').click();
        await settle();
        await save(dom);
        expect(lastSave()).toEqual({ id: 'p_agentic', folders: { 'alien01/*': 'C:\\Dev\\agentic\\main', 'alien01/env_alien01_personal': 'C:\\Users\\andy\\src\\agentic' } });
    });
});

describe('Settings › Connectors (mock)', () => {
    it('the connectors as chips over the enabled connector plugins; a save sends only them', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/connectors');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="connectors"]')!;
        expect(text(tab)).toContain('GitHub (MCP)');
        await save(tab);
        expect(lastSave()).toEqual({ id: 'p_agentic', connectors: [{ id: 'github-mcp' }] });
    });

    it('tabPatchOf picks the tab\u2019s keys of the whole-form patch, with the id', () => {
        const project = PROJECTS[0]!;
        expect(tabPatchOf({ ...projectDraftOf(project), name: 'x' }, project, ['name'])).toEqual({ id: 'p_agentic', name: 'x' });
    });
});

describe('/projects/new: the New project dialog (#733)', () => {
    it('opens over the index on a blank project', async () => {
        const dom = await mountRoute('/projects/new');
        expect(page(dom, 'projects')).not.toBeNull();
        expect(dialog().getAttribute('data-step')).toBe('project');
        expect(dialog().querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('');
        expect(dialog().querySelector('[data-project-folder]')!.getAttribute('data-project-folder')).toBe('');
    });

    it('prefilled from a folder (#336): the name, the folder on the machine reporting the environment, the origin as its badge', async () => {
        const path = 'C:\\Dev\\agentic\\branches\\x';
        await mountRoute(`/projects/new?name=agentic&env=env_alien01_work&path=${encodeURIComponent(path)}&origin=${encodeURIComponent(AGENTIC_ORIGIN)}`);
        expect(dialog().querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        const folder = dialog().querySelector<HTMLElement>('[data-project-folder="alien01"]')!;
        expect(chip(folder)).toContain('x');
        expect(texts([...folder.querySelectorAll('[data-project-folder-meta] [data-scope="badge"][data-part="root"]')])).toEqual(['repo']);
    });

    it('a name alone prefills just the name', async () => {
        await mountRoute('/projects/new?name=blog');
        expect(dialog().querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('blog');
        expect(dialog().querySelector('[data-project-folder]')!.getAttribute('data-project-folder')).toBe('');
    });

    async function mountDialog(): Promise<ProjectPatch[]> {
        const created: ProjectPatch[] = [];
        await mountAt('/projects/new', (
            <NewProjectDialog model={() => true} machines={mockWorkdirEnvironments.projectMachines()} locate={mockLocate()} skills={[]} onCreate={(p) => created.push(p)} />
        ));
        await settle();
        return created;
    }

    it('the project step, then the Project manager step: a suggested name, preset cards with a sample line, custom text; Create sends pm', async () => {
        const created = await mountDialog();
        buttonIn(dialogForm(), 'Next: project manager').click();
        await settle();
        // The name is required: the step stays.
        expect(dialog().getAttribute('data-step')).toBe('project');
        setText(dialog().querySelector<HTMLInputElement>('input[name="project-name"]')!, 'launch');
        setText(dialog().querySelector<HTMLTextAreaElement>('textarea[name="project-description"]')!, 'The spring launch.');
        buttonIn(dialogForm(), 'Next: project manager').click();
        await settle();
        expect(dialog().getAttribute('data-step')).toBe('manager');
        expect(dialog().querySelector<HTMLInputElement>('input[name="pm-name"]')!.value).toBe('launch PM');
        const cards = (): HTMLElement[] => [...dialog().querySelectorAll<HTMLElement>('[data-pm-personality]')];
        expect(cards().map((c) => c.getAttribute('data-pm-personality'))).toEqual([...PM_PERSONALITIES.map((p) => p.id), 'custom']);
        expect(text(cards()[0]!.querySelector('[data-pm-personality-sample]'))).toBe(PERSONALITY_SAMPLES['calm-organiser']);
        // The default preset goes as is.
        buttonIn(dialogForm(), 'Create project').click();
        await settle();
        expect(created).toEqual([{ name: 'launch', description: 'The spring launch.', pm: { name: 'launch PM', personality: { preset: 'calm-organiser' }, skills: [] } }]);
        // Custom needs its text; Back keeps what was typed.
        cards()[cards().length - 1]!.click();
        await settle();
        buttonIn(dialogForm(), 'Create project').click();
        await settle();
        expect(created.length).toBe(1);
        expect(text(dialog())).toContain('Describe how the project manager works');
        setText(dialog().querySelector<HTMLTextAreaElement>('textarea[name="pm-custom"]')!, 'Short and blunt.');
        await settle();
        buttonIn(dialogForm(), 'Create project').click();
        await settle();
        expect(created[1]?.pm).toEqual({ name: 'launch PM', personality: { custom: 'Short and blunt.' }, skills: [] });
        buttonIn(dialog(), 'Back').click();
        await settle();
        expect(dialog().querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('launch');
    });

    it('Find by repo lists the checkouts and Use takes one as the folder', async () => {
        await mountDialog();
        setText(dialog().querySelector<HTMLInputElement>('input[name="project-origin"]')!, AGENTIC_ORIGIN);
        await settle();
        buttonIn(dialog(), 'Find').click();
        await settle();
        const matches = [...dialog().querySelectorAll('[data-project-match-path]')];
        expect(matches.length).toBeGreaterThan(0);
        const first = matches[0]!.textContent!;
        buttonIn(dialog(), 'Use').click();
        await settle();
        expect(chip(dialog().querySelector('[data-project-folder]')!)).toContain(first.split('\\').pop()!);
        expect(dialog().querySelector('[data-new-project-find]')).toBeNull();
    });

    it('newProjectPatchOf: the folder when picked, a custom personality trimmed, the skills de-duplicated', () => {
        const d = { ...blankNewProject(), name: ' x ', folder: { key: 'alien01/*', row: { path: 'C:\\Dev\\x' } }, personality: 'custom', pmCustom: '  Calm.  ', skills: ['a', ' a ', 'b', ''] };
        expect(newProjectPatchOf(d)).toEqual({ name: 'x', folders: { 'alien01/*': 'C:\\Dev\\x' }, pm: { name: 'x PM', personality: { custom: 'Calm.' }, skills: [{ id: 'a' }, { id: 'b' }] } });
        expect(suggestedPmName('')).toBe('Project manager');
    });
});

describe('the project form (mock)', () => {
    async function mountForm(extra: { catalogue?: Readonly<Record<string, ProjectFeaturePlugin>> } = {}) {
        const saved: ProjectPatch[] = [];
        const dom = await mountAt('/projects/new', (
            <ProjectForm
                agents={AGENTS}
                environments={mockWorkdirEnvironments.list()}
                machines={mockWorkdirEnvironments.projectMachines()}
                connectors={connectorOptionsOf(opsPlugins)}
                features={featureManifestsOf(opsPlugins)}
                locate={mockLocate()}
                {...(extra.catalogue ? { catalogue: extra.catalogue } : {})}
                onSave={(p) => saved.push(p)}
            />
        ));
        return { dom, saved };
    }

    it('Browse keeps the folder\u2019s git badge on the row; Find offers the mock locate matches and fills another row; a foreign origin warns', async () => {
        const { dom } = await mountForm();
        expect(dom.querySelectorAll('[data-project-folder] button').length).toBeGreaterThan(0);
        // No origin yet: no Find anywhere.
        expect([...dom.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.trim() === 'Find')).toBe(false);
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'agentic', 'main');
        expect(chip(row(dom, 'alien01'))).toContain('agentic');
        // The build's git feature (#335) detects the badge and suggests itself on the row.
        expect(texts([...row(dom, 'alien01').querySelectorAll('[data-project-folder-meta] [data-scope="badge"][data-part="root"]')])).toEqual(['repo · main', 'Git']);
        // Now every empty row offers Find; the offline machine's row cannot.
        expect(row(dom, 'nuc-lab').querySelector<HTMLButtonElement>('button[disabled]')).not.toBeNull();
        await openOverrides(dom, 'alien01');
        expect(buttonIn(override(dom, 'alien01', 'env_alien01_personal'), 'Find')).toBeTruthy();

        buttonIn(override(dom, 'alien01', 'env_alien01_personal'), 'Find').click();
        await settle();
        const popup = openPopup();
        const matches = mockFsLocate('env_alien01_personal', AGENTIC_ORIGIN);
        expect('matches' in matches && matches.matches.map((m) => m.path)).toEqual(['C:\\Users\\andy\\src\\agentic']);
        expect(texts([...popup.querySelectorAll('[data-project-match-path]')])).toEqual(['C:\\Users\\andy\\src\\agentic']);
        // The first match is in effect until another is picked: confirming without touching a radio uses it.
        expect(popup.querySelector<HTMLInputElement>('input[name="project-locate-match"]')!.checked).toBe(true);
        buttonIn(popup, 'Use this folder').click();
        await settle();
        expect(chip(override(dom, 'alien01', 'env_alien01_personal'))).toContain('agentic');
        expect(dom.querySelector('[data-project-folder-warning]')).toBeNull();

        // No match to use (here: the mock has no tree for the codex environment, an error): confirming keeps the dialog and its answer in view; Cancel closes it.
        // An environment that inherits the machine's folder can still look for another checkout of its own.
        buttonIn(override(dom, 'alien01', 'env_alien01_codex'), 'Find').click();
        await settle();
        // The error line is the kit ErrorNote (#592): zero's Alert, announced, keeping its hook.
        const locateError = openPopup().querySelector('[data-project-locate="error"]')!;
        expect([locateError.getAttribute('data-scope'), locateError.getAttribute('role')]).toEqual(['alert', 'alert']);
        buttonIn(openPopup(), 'Use this folder').click();
        await settle();
        expect(openPopup()).not.toBeNull();
        expect(openPopup().querySelector('[data-project-locate="error"]')).not.toBeNull();
        buttonIn(openPopup(), 'Cancel').click();
        await settle();
        expect(document.querySelector('[data-scope="dialog"][data-part="popup"][data-state="open"]')).toBeNull();

        // Another repo on the work row: both rows now disagree, and say so without blocking.
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'sigx');
        expect(row(dom, 'alien01').hasAttribute('data-mismatch')).toBe(true);
        expect(text(row(dom, 'alien01').querySelector('[data-project-folder-warning]'))).toContain('another origin');
    });

    it('a feature switched on renders its settings from the schema with the origin prefilled from the folders; detect preselects it', async () => {
        const catalogue: Readonly<Record<string, ProjectFeaturePlugin>> = { 'agentic.feature.git': { manifest: featureManifestsOf(opsPlugins)[0]!, detect: (f) => !!f.git } };
        const { dom } = await mountForm({ catalogue });
        const feature = () => dom.querySelector<HTMLElement>('[data-project-feature="agentic.feature.git"]')!;
        expect(feature().hasAttribute('data-on')).toBe(false);
        expect(feature().querySelector('[data-form="schema"]')).toBeNull();
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'agentic', 'main');
        // The badge said "repo": the plugin's detect suggested the feature, the row shows it, and the settings opened on the origin.
        expect(texts([...row(dom, 'alien01').querySelectorAll('[data-project-folder-meta] [data-scope="badge"][data-part="root"]')])).toEqual(['repo · main', 'Git']);
        expect(feature().hasAttribute('data-on')).toBe(true);
        expect(feature().querySelector<HTMLInputElement>('input[name="feature-agentic.feature.git.origin"]')!.value).toBe(AGENTIC_ORIGIN);
        expect(feature().querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    });

    it('a save produces the patch: name, roster with coordinator, connectors, folders and the feature settings; no name keeps it here', async () => {
        const { dom, saved } = await mountForm();
        buttonIn(dom, 'Create project').click();
        await settle();
        expect(saved).toEqual([]);
        expect(text(dom.querySelector('[data-scope="field"][data-part="error"]'))).toBe('A name is required.');
        setText(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!, ' agentic ');
        for (const id of ['forge', 'lint']) {
            const box = dom.querySelector<HTMLInputElement>(`[data-new-chat-agent="${id}"] input[name="member"]`)!;
            box.checked = true;
            box.dispatchEvent(new Event('change', { bubbles: true }));
            await settle();
        }
        const radio = dom.querySelector<HTMLInputElement>('[data-new-chat-agent="forge"] input[name="coordinator"]')!;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'agentic', 'main');
        // The badge switched the build's git feature on (detect, #335) with the origin prefilled: nothing to click.
        expect(dom.querySelector<HTMLInputElement>('[data-project-feature="agentic.feature.git"] input[role="switch"]')!.checked).toBe(true);
        buttonIn(dom, 'Create project').click();
        await settle();
        expect(saved).toEqual([{
            name: 'agentic',
            members: { agentIds: ['forge', 'lint'], coordinator: 'forge' },
            folders: { 'alien01/*': 'C:\\Dev\\agentic\\main' },
            connectors: [],
            features: { 'agentic.feature.git': { origin: AGENTIC_ORIGIN } }
        }]);
    });

    it('a feature\u2019s presets fill its fields, the preview follows the draft, and the plugin\u2019s own errors keep the page here (#621)', async () => {
        const { dom, saved } = await mountForm();
        setText(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!, 'agentic');
        await browse(row(dom, 'alien01'), 'C:\\Dev', 'agentic', 'main');
        const feature = () => dom.querySelector<HTMLElement>('[data-project-feature="agentic.feature.git"]')!;
        const preview = () => Object.fromEntries([...feature().querySelectorAll('[data-project-feature-preview-line]')].map((l) => [text(l.querySelector('dt')), text(l.querySelector('dd'))]));
        const field = (key: string) => feature().querySelector<HTMLInputElement>(`input[name="feature-agentic.feature.git.${key}"]`)!;
        expect(preview()).toEqual({ Worktrees: 'off: sessions open in the project folder' });
        field('worktreePerChat').click();
        await settle();
        expect(preview()).toMatchObject({ Branch: 'chat/a1b2c3d4', Folder: 'C:\\Dev\\agentic\\branches\\chat-a1b2c3d4', 'Made by': 'git worktree add' });

        buttonIn(feature(), 'Inside the repo').click();
        await settle();
        expect(field('worktreePath').value).toBe('{repo}/.worktrees/{branchSlug}');
        expect(preview()).toMatchObject({ Folder: 'C:\\Dev\\agentic\\main\\.worktrees\\chat-a1b2c3d4' });
        // Every field stays editable after a preset; a token the plugin does not know is its error, and the save waits.
        setText(field('worktreePath'), '{repo}/{nope}');
        await settle();
        expect(text(feature().querySelector('[data-project-feature-errors]'))).toContain('{nope}');
        expect(preview()).toMatchObject({ Problem: expect.stringContaining('{nope}') });
        buttonIn(dom, 'Create project').click();
        await settle();
        expect(saved).toEqual([]);
        expect(text(dom.querySelector('[data-project-error]'))).toBe('Check the Git settings.');
        expect(dom.querySelector('[data-project-error]')!.getAttribute('role')).toBe('alert');
        expect(feature().querySelector('[data-project-feature-errors]')!.getAttribute('role')).toBe('alert');
        // Nothing in the form is a hand-stamped <p role="alert"> any more.
        expect(dom.querySelector('p[role="alert"], ul[role="alert"]')).toBeNull();

        buttonIn(feature(), 'Git default').click();
        await settle();
        expect(field('worktreePath').value).toBe('');
        expect(feature().querySelector('[data-project-feature-errors]')).toBeNull();
        buttonIn(dom, 'Create project').click();
        await settle();
        expect(saved[0]?.features).toEqual({ 'agentic.feature.git': { origin: AGENTIC_ORIGIN, worktreePerChat: true } });
    });

    it('the phone regime: the form and the list have no element wider than 400 px worth of columns (one column each)', async () => {
        const { dom } = await mountForm();
        // happy-dom does no layout; the structural rule is what the CSS pins: every grid on the form collapses to one column below 768.
        expect(dom.querySelector('[data-project-form]')).not.toBeNull();
        expect(dom.querySelectorAll('[data-project-folder]').length).toBe(mockWorkdirEnvironments.projectMachines().length);
        expect(PROJECTS.length).toBe(2);
    });
});
