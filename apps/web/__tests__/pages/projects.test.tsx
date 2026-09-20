/**
 * `/projects` and the project form on mock data (#333): the list with its
 * environment badges, one folder row per daemon environment, Browse keeping
 * the folder's git badge on the row, Find through the mock `locate`, the
 * different-origin warning, a feature's settings from its manifest schema
 * with the origin prefilled, `detect` suggesting a feature, and the patch a
 * save produces.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectFeaturePlugin, ProjectPatch } from '@agentic/core';
import { AGENTS, PROJECTS } from '../../src/mock/workspace';
import { AGENTIC_ORIGIN, mockFsLocate } from '../../src/mock/fs';
import { opsPlugins } from '../../src/mock/ops';
import { topbarFor } from '../../src/components/topbar';
import { mockLocate } from '../../src/pages/projects/locate';
import { connectorOptionsOf, featureManifestsOf } from '../../src/pages/projects/model';
import { ProjectForm } from '../../src/pages/projects/ProjectForm';
import { mockWorkdirEnvironments } from '../../src/pages/workdir/environments';
import { mountAt, setText, text } from './helpers';
import { mountRoute, page, texts } from './mount';

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const row = (dom: ParentNode, env: string): HTMLElement => dom.querySelector<HTMLElement>(`[data-project-folder="${env}"]`)!;
const openPopup = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && !x.disabled);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};

/** Browse: open the row's picker, walk `path` from the root shortcut, use the folder. */
async function browse(dom: ParentNode, env: string, root: string, ...names: string[]): Promise<void> {
    buttonIn(row(dom, env), 'Change…').click();
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

describe('/projects (mock)', () => {
    it('lists both projects with a badge per environment that has a folder, the members and the enabled features; the topbar offers New project', async () => {
        const dom = await mountRoute('/projects');
        expect(page(dom, 'projects')).not.toBeNull();
        const rows = [...dom.querySelectorAll<HTMLElement>('[data-project-row]')];
        expect(rows.map((r) => r.getAttribute('data-project-row'))).toEqual(['p_agentic', 'p_docs']);
        expect(texts([...rows[0]!.querySelectorAll('.project-env')])).toEqual(['alien01 / work', 'alien01 / personal']);
        expect(texts([...rows[0]!.querySelectorAll('.project-feature')])).toEqual(['Git']);
        expect(rows[0]!.querySelectorAll('[data-member-tiles] [data-scope="ag-agent-tile"][data-part="root"]').length).toBe(3);
        expect(texts([...rows[1]!.querySelectorAll('.project-env')])).toEqual(['alien01 / personal']);
        expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic');
        expect(text(topbarFor({ name: 'projects', path: '/projects', params: {} })?.actions?.() as never)).toBe('');
        expect(topbarFor({ name: 'project', path: '/projects/p_agentic', params: { id: 'p_agentic' } })?.crumb).toBe('agentic');
        expect(topbarFor({ name: 'project-new', path: '/projects/new', params: {} })?.crumb).toBe('New project');
    });

    it('the edit page renders the enabled feature\u2019s settings from the manifest schema, filled from the record', async () => {
        const dom = await mountRoute('/projects/p_agentic');
        expect(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        const feature = dom.querySelector<HTMLElement>('[data-project-feature="agentic.feature.git"]')!;
        expect(feature.hasAttribute('data-on')).toBe(true);
        expect(feature.querySelector('[data-form="schema"]')).not.toBeNull();
        expect(feature.querySelector<HTMLInputElement>('input[name="feature-agentic.feature.git.origin"]')!.value).toBe(AGENTIC_ORIGIN);
        // A plain text field: an origin is whatever git wrote (`git@host:path` is no URL), so the schema declares no `format` (#335).
        expect(feature.querySelector('input[name="feature-agentic.feature.git.origin"]')!.getAttribute('type')).toBe('text');
        expect(feature.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
        // One folder row per daemon environment, the stored ones filled.
        expect([...dom.querySelectorAll('[data-project-folder]')].map((r) => r.getAttribute('data-project-folder'))).toEqual(mockWorkdirEnvironments.list().map((e) => e.id));
        expect(text(row(dom, 'env_alien01_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('agentic');
        expect(text(row(dom, 'env_nuclab_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('No folder on this environment');
    });
});

describe('/projects/new from a folder (#336)', () => {
    it('opens on the name, the folder row with the origin as its badge, and Find on the other rows', async () => {
        const path = 'C:\\Dev\\agentic\\branches\\x';
        const dom = await mountRoute(`/projects/new?name=agentic&env=env_alien01_work&path=${encodeURIComponent(path)}&origin=${encodeURIComponent(AGENTIC_ORIGIN)}`);
        expect(page(dom, 'project')).not.toBeNull();
        expect(dom.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        expect(text(row(dom, 'env_alien01_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('x');
        expect(texts([...row(dom, 'env_alien01_work').querySelectorAll('[data-project-folder-meta] [data-scope="ag-pill"][data-part="root"]')])).toContain('repo');
        expect(buttonIn(row(dom, 'env_alien01_personal'), 'Find')).toBeTruthy();
        expect(text(row(dom, 'env_nuclab_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('No folder on this environment');
    });

    it('a name alone, or a folder without an origin, prefill just that', async () => {
        const named = await mountRoute('/projects/new?name=blog');
        expect(named.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('blog');
        expect([...named.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.trim() === 'Find')).toBe(false);
        const plain = await mountRoute(`/projects/new?env=env_alien01_work&path=${encodeURIComponent('C:\\notes')}`);
        expect(plain.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('');
        expect(text(row(plain, 'env_alien01_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('notes');
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
                machineOf={mockWorkdirEnvironments.machineOf}
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
        await browse(dom, 'env_alien01_work', 'C:\\Dev', 'agentic', 'main');
        expect(text(row(dom, 'env_alien01_work').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('agentic');
        // The build's git feature (#335) detects the badge and suggests itself on the row.
        expect(texts([...row(dom, 'env_alien01_work').querySelectorAll('[data-project-folder-meta] [data-scope="ag-pill"][data-part="root"]')])).toEqual(['repo · main', 'Git']);
        // Now every empty row offers Find; the offline machine's row says why it cannot.
        expect(buttonIn(row(dom, 'env_alien01_personal'), 'Find')).toBeTruthy();
        expect(row(dom, 'env_nuclab_work').querySelector<HTMLButtonElement>('button[disabled]')).not.toBeNull();

        buttonIn(row(dom, 'env_alien01_personal'), 'Find').click();
        await settle();
        const popup = openPopup();
        const matches = mockFsLocate('env_alien01_personal', AGENTIC_ORIGIN);
        expect('matches' in matches && matches.matches.map((m) => m.path)).toEqual(['C:\\Users\\andy\\src\\agentic']);
        expect(texts([...popup.querySelectorAll('[data-project-match-path]')])).toEqual(['C:\\Users\\andy\\src\\agentic']);
        // The first match is in effect until another is picked: confirming without touching a radio uses it.
        expect(popup.querySelector<HTMLInputElement>('input[name="project-locate-match"]')!.checked).toBe(true);
        buttonIn(popup, 'Use this folder').click();
        await settle();
        expect(text(row(dom, 'env_alien01_personal').querySelector('[data-scope="ag-workdir"][data-part="chip"]'))).toContain('agentic');
        expect(dom.querySelector('[data-project-folder-warning]')).toBeNull();

        // No match to use (here: the mock has no tree for the codex environment, an error): confirming keeps the dialog and its answer in view; Cancel closes it.
        buttonIn(row(dom, 'env_alien01_codex'), 'Find').click();
        await settle();
        expect(openPopup().querySelector('[data-project-locate="error"]')).not.toBeNull();
        buttonIn(openPopup(), 'Use this folder').click();
        await settle();
        expect(openPopup()).not.toBeNull();
        expect(openPopup().querySelector('[data-project-locate="error"]')).not.toBeNull();
        buttonIn(openPopup(), 'Cancel').click();
        await settle();
        expect(document.querySelector('[data-scope="dialog"][data-part="popup"][data-state="open"]')).toBeNull();

        // Another repo on the work row: both rows now disagree, and say so without blocking.
        await browse(dom, 'env_alien01_work', 'C:\\Dev', 'sigx');
        expect(row(dom, 'env_alien01_work').hasAttribute('data-mismatch')).toBe(true);
        expect(text(row(dom, 'env_alien01_work').querySelector('[data-project-folder-warning]'))).toContain('another origin');
    });

    it('a feature switched on renders its settings from the schema with the origin prefilled from the folders; detect preselects it', async () => {
        const catalogue: Readonly<Record<string, ProjectFeaturePlugin>> = { 'agentic.feature.git': { manifest: featureManifestsOf(opsPlugins)[0]!, detect: (f) => !!f.git } };
        const { dom } = await mountForm({ catalogue });
        const feature = () => dom.querySelector<HTMLElement>('[data-project-feature="agentic.feature.git"]')!;
        expect(feature().hasAttribute('data-on')).toBe(false);
        expect(feature().querySelector('[data-form="schema"]')).toBeNull();
        await browse(dom, 'env_alien01_work', 'C:\\Dev', 'agentic', 'main');
        // The badge said "repo": the plugin's detect suggested the feature, the row shows it, and the settings opened on the origin.
        expect(texts([...row(dom, 'env_alien01_work').querySelectorAll('[data-project-folder-meta] [data-scope="ag-pill"][data-part="root"]')])).toEqual(['repo · main', 'Git']);
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
        await browse(dom, 'env_alien01_work', 'C:\\Dev', 'agentic', 'main');
        // The badge switched the build's git feature on (detect, #335) with the origin prefilled: nothing to click.
        expect(dom.querySelector<HTMLInputElement>('[data-project-feature="agentic.feature.git"] input[role="switch"]')!.checked).toBe(true);
        buttonIn(dom, 'Create project').click();
        await settle();
        expect(saved).toEqual([{
            name: 'agentic',
            members: { agentIds: ['forge', 'lint'], coordinator: 'forge' },
            folders: { env_alien01_work: 'C:\\Dev\\agentic\\main' },
            connectors: [],
            features: { 'agentic.feature.git': { origin: AGENTIC_ORIGIN } }
        }]);
    });

    it('the phone regime: the form and the list have no element wider than 400 px worth of columns (one column each)', async () => {
        const { dom } = await mountForm();
        // happy-dom does no layout; the structural rule is what the CSS pins: every grid on the form collapses to one column below 768.
        expect(dom.querySelector('[data-project-form]')).not.toBeNull();
        expect(dom.querySelectorAll('[data-project-folder]').length).toBe(mockWorkdirEnvironments.list().length);
        expect(PROJECTS.length).toBe(2);
    });
});
