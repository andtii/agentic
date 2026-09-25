/**
 * The sidebar's project switcher (#794): on a project route the `Projects` entry carries the open project's
 * switcher (#727), and pressing it opens the project picker `ProjectLayout` mounts (#728). Off a project route there
 * is no switcher. The sub-menu draws Chats' plain count beside Work's needs-you badge.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { installThemes } from '@agentic/ui/design-system';
import { App } from '../../src/App';
import { projectPicker } from '../../src/pages/projects/layout/ProjectPicker';
import { mountAt, tick } from '../pages/helpers';

// `App` links the font stylesheet in <head>; happy-dom would go and fetch it.
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
afterEach(() => {
    projectPicker.open = false;
});

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await tick(); };
const switcher = (dom: ParentNode) => dom.querySelector<HTMLButtonElement>('[data-nav-switcher]');

describe('the sidebar project switcher (#794)', () => {
    it('names the open project and opens the project picker when pressed', async () => {
        const dom = await mountAt('/projects/p_agentic', <App />);
        await settle();
        const button = switcher(dom)!;
        expect(button).not.toBeNull();
        expect(button.getAttribute('aria-label')).toBe('Switch project');
        expect(button.querySelector('[data-nav-switcher-name]')?.textContent).toBe('agentic');
        expect(projectPicker.open).toBe(false);
        button.click();
        await settle();
        expect(projectPicker.open).toBe(true);
        expect(document.querySelector('input[name="project-search"]')).not.toBeNull();
    });

    it('draws Chats’ plain count and Work’s needs-you badge in the project menu', async () => {
        const dom = await mountAt('/projects/p_agentic', <App />);
        await settle();
        const link = (label: string) => [...dom.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.getAttribute('href') === `/projects/p_agentic${label}`);
        expect(link('/chats')?.querySelector('[data-nav-count]')?.textContent).toBe('5');
        expect(link('/work')?.querySelector('[data-scope="badge"]')?.textContent).toBe('3');
    });

    it('draws no switcher off a project route', async () => {
        const dom = await mountAt('/projects', <App />);
        await settle();
        expect(switcher(dom)).toBeNull();
    });
});
