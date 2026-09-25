/**
 * The project form on mock data (#333; split out of `pages/projects.test.tsx` by the scaffold #725, the edit page now
 * at Settings › General): one folder row per machine with an override per environment on it (#702), Browse keeping
 * the folder's git badge on the row, Find through the mock `locate`, the different-origin warning, a feature's
 * settings from its manifest schema with the origin prefilled, `detect` suggesting a feature, and the patch a save
 * produces; `/projects/new` prefilled from a folder (#336). #733 owns this file.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFeaturePlugin, ProjectPatch } from '@agentic/core';
import { AGENTS, PROJECTS } from '../../src/mock/workspace';
import { AGENTIC_ORIGIN, mockFsLocate } from '../../src/mock/fs';
import { opsPlugins } from '../../src/mock/ops';
import { mockLocate } from '../../src/pages/projects/locate';
import { connectorOptionsOf, featureManifestsOf } from '../../src/pages/projects/model';
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

describe('/projects/:id/settings/general (mock)', () => {
    it('the edit page renders the enabled feature\u2019s settings from the manifest schema, filled from the record', async () => {
        const dom = await mountRoute('/projects/p_agentic/settings/general');
        expect(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        const feature = dom.querySelector<HTMLElement>('[data-project-feature="agentic.feature.git"]')!;
        expect(feature.hasAttribute('data-on')).toBe(true);
        expect(feature.querySelector('[data-form="schema"]')).not.toBeNull();
        expect(feature.querySelector<HTMLInputElement>('input[name="feature-agentic.feature.git.origin"]')!.value).toBe(AGENTIC_ORIGIN);
        // A plain text field: an origin is whatever git wrote (`git@host:path` is no URL), so the schema declares no `format` (#335).
        expect(feature.querySelector('input[name="feature-agentic.feature.git.origin"]')!.getAttribute('type')).toBe('text');
        expect(feature.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
        // One folder row per machine (#702), the stored ones filled; an environment with its own folder shows it, the others the machine's.
        expect([...dom.querySelectorAll('[data-project-folder]')].map((r) => r.getAttribute('data-project-folder'))).toEqual(['alien01', 'nuc-lab']);
        expect(chip(row(dom, 'alien01'))).toContain('agentic');
        expect(chip(override(dom, 'alien01', 'env_alien01_personal'))).toContain('agentic');
        expect(chip(override(dom, 'alien01', 'env_alien01_codex'))).toContain("The machine's folder");
        // The acme environment's roots do not hold the machine's folder: it says so.
        expect(text(override(dom, 'alien01', 'env_alien01_client_acme'))).toContain("outside this environment's folders");
        expect(chip(row(dom, 'nuc-lab'))).toContain('No folder on this machine');
    });
});

describe('/projects/new from a folder (#336)', () => {
    it('opens on the name, the folder row with the origin as its badge, and Find on the other rows', async () => {
        const path = 'C:\\Dev\\agentic\\branches\\x';
        const dom = await mountRoute(`/projects/new?name=agentic&env=env_alien01_work&path=${encodeURIComponent(path)}&origin=${encodeURIComponent(AGENTIC_ORIGIN)}`);
        expect(page(dom, 'project')).not.toBeNull();
        expect(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        // The folder of `env` lands on the machine reporting it (#702).
        expect(chip(row(dom, 'alien01'))).toContain('x');
        expect(texts([...row(dom, 'alien01').querySelectorAll('[data-project-folder-meta] [data-scope="badge"][data-part="root"]')])).toContain('repo');
        await openOverrides(dom, 'alien01');
        expect(buttonIn(override(dom, 'alien01', 'env_alien01_personal'), 'Find')).toBeTruthy();
        expect(chip(row(dom, 'nuc-lab'))).toContain('No folder on this machine');
    });

    it('a name alone, or a folder without an origin, prefill just that', async () => {
        const named = await mountRoute('/projects/new?name=blog');
        expect(named.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('blog');
        expect([...named.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.trim() === 'Find')).toBe(false);
        const plain = await mountRoute(`/projects/new?env=env_alien01_work&path=${encodeURIComponent('C:\\Dev\\notes')}`);
        expect(plain.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('');
        expect(chip(row(plain, 'alien01'))).toContain('notes');
        expect([...plain.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.trim() === 'Find')).toBe(false);
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
