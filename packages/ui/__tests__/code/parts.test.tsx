/**
 * The Changes and Files parts (#563): lists, session bar, header, the
 * ask-about-a-line composer, `Go to file`, the file tree, the Monaco theme
 * built from tokens, and the scopes' place in the design system.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeManifests, validateDesignSystem, type ZeroManifest } from '@sigx/zero-kit';
import type { ChangeCommit, ChangedFile, FsTreeEntry } from '@agentic/core';
import { all, buttonNamed, mount, one, tick, waitFor } from '../helpers';
import { ChangeList, ChangesPanel, CommitList, FileHeader, FileTree, FileTreeLegend, GoToFile, LineComposer, SessionBar, StatusTile, ancestorsOf, codeAnatomies, codeRecipes, codeScopes, fileSizeText, findPaths, monacoTheme, splitPath, withAlpha } from '../../src';
import { designSystem, palette, tokens } from '../../src/design-system';
import { fragment } from '../../src/fragment';

const FILES: ChangedFile[] = [
    { path: 'packages/ui/src/shell/shell.css', status: 'modified', added: 18, removed: 6 },
    { path: 'packages/ui/src/shell/Drawer.tsx', status: 'modified', added: 4, removed: 2 },
    { path: 'packages/ui/src/shell/drawer.test.ts', status: 'added', added: 2 }
];
const COMMITS: ChangeCommit[] = [
    { id: 'a41c9e2aaaa', short: 'a41c9e2', subject: 'shell: drawer state on data-l-drawer', at: new Date(2026, 8, 23, 14, 6).getTime(), author: 'Forge' },
    { id: '7be0d13bbbb', short: '7be0d13', subject: 'shell: extract breakpoint token', at: new Date(2026, 8, 23, 14, 4).getTime(), author: 'Forge' }
];

describe('the Changes list column', () => {
    it('lists files with their status, folder and counts, totals the group, and marks the open one', () => {
        const opened: string[] = [];
        const root = mount(
            <ChangesPanel note="Read-only. Files stay on alien01; the daemon sends what you open.">
                <ChangeList files={FILES} current="packages/ui/src/shell/shell.css" href={(f) => `/sessions/s1/changes?file=${encodeURIComponent(f.path)}`} onOpen={(f, e) => { e.preventDefault(); opened.push(f.path); }} />
                <CommitList commits={COMMITS} base="main" author={() => ({ name: 'Forge', hue: 2 })} />
            </ChangesPanel>
        );
        const items = all(root, 'ag-changes', 'item');
        expect(items.map((i) => i.querySelector('[data-part="name"]')!.textContent)).toEqual(['shell.css', 'Drawer.tsx', 'drawer.test.ts']);
        expect(items[0]!.getAttribute('aria-current')).toBe('true');
        expect(items[1]!.hasAttribute('aria-current')).toBe(false);
        expect(items[0]!.getAttribute('href')).toBe('/sessions/s1/changes?file=packages%2Fui%2Fsrc%2Fshell%2Fshell.css');
        expect(items[0]!.querySelector('[data-part="folder"]')!.textContent).toBe('‎packages/ui/src/shell‎');
        expect(items[2]!.querySelector('[data-scope="ag-status-tile"]')!.getAttribute('aria-label')).toBe('Added');
        // An added file counts only what it has.
        expect(items[2]!.querySelector('[data-part="removed"]')).toBeNull();
        const heading = all(root, 'ag-changes', 'heading')[0]!;
        expect(heading.textContent).toBe('Uncommitted+24−8');
        items[1]!.click();
        expect(opened).toEqual(['packages/ui/src/shell/Drawer.tsx']);

        const commits = all(root, 'ag-changes', 'commit');
        expect(commits[0]!.textContent).toContain('shell: drawer state on data-l-drawer');
        expect(commits[0]!.textContent).toContain('a41c9e2 · 14:06');
        expect(commits[0]!.querySelector('[data-scope="ag-agent-tile"]')!.getAttribute('aria-label')).toBe('Forge');
        expect(all(root, 'ag-changes', 'aside')[0]!.textContent).toBe('vs main');
        expect(one(root, 'ag-changes', 'note')!.textContent).toContain('Files stay on alien01');
    });

    it('says so when a group is empty', () => {
        const root = mount(<ChangeList files={[]} href={() => '#'} empty="No uncommitted changes" />);
        expect(one(root, 'ag-changes', 'empty')!.textContent).toBe('No uncommitted changes');
    });
});

describe('the session bar', () => {
    it('links the views, marks the open one, and shows who and where the session runs', () => {
        const root = mount(
            <SessionBar
                tabs={[
                    { id: 'transcript', label: 'Transcript', href: '/sessions/s1' },
                    { id: 'changes', label: 'Changes', href: '/sessions/s1/changes', count: 3, current: true },
                    { id: 'files', label: 'Files', href: '/sessions/s1/files' }
                ]}
                agent={{ name: 'Forge', hue: 2 }}
                env="alien01 / work"
                branch="47-mobile-drawer"
                ahead={{ count: 2, base: 'main' }}
            >
                <button type="button">Unified</button>
            </SessionBar>
        );
        const tabs = all(root, 'ag-session-bar', 'tab');
        expect(tabs.map((t) => t.getAttribute('aria-current'))).toEqual([null, 'page', null]);
        expect(tabs[1]!.textContent).toBe('Changes3');
        expect(one(root, 'ag-session-bar', 'tabs')!.getAttribute('aria-label')).toBe('Session views');
        expect(one(root, 'ag-session-bar', 'env')!.textContent).toBe('alien01 / work');
        expect(one(root, 'ag-session-bar', 'branch')!.textContent).toBe('47-mobile-drawer');
        expect(one(root, 'ag-session-bar', 'ahead')!.textContent).toBe('2 ahead of main');
        expect(one(root, 'ag-session-bar', 'controls')!.textContent).toBe('Unified');
    });

    it('drops the context and the controls when it has none', () => {
        const root = mount(<SessionBar tabs={[{ id: 'transcript', label: 'Transcript', href: '/sessions/s9', current: true }]} />);
        expect(one(root, 'ag-session-bar', 'divider')).toBeNull();
        expect(one(root, 'ag-session-bar', 'controls')).toBeNull();
    });
});

describe('the file header', () => {
    it('writes the path with the name emphasised, as a path or as breadcrumbs', () => {
        const diff = mount(<FileHeader path="packages/ui/src/shell/shell.css" status="modified" added={18} removed={6}><a href="#">Edit at 14:09</a></FileHeader>);
        expect(one(diff, 'ag-file-header', 'path')!.textContent).toBe('packages/ui/src/shell/shell.css');
        expect(one(diff, 'ag-file-header', 'name')!.textContent).toBe('shell.css');
        expect(one(diff, 'ag-file-header', 'actions')!.textContent).toBe('Edit at 14:09');
        const viewer = mount(<FileHeader path="packages/ui/src/shell/shell.css" status="modified" breadcrumbs facts={`82 lines · ${fileSizeText(2150)}`} />);
        expect(one(viewer, 'ag-file-header', 'path')!.textContent).toBe('packages / ui / src / shell / shell.css');
        expect(one(viewer, 'ag-file-header', 'facts')!.textContent).toBe('82 lines · 2.1 KB');
    });

    it('draws each status as its letter with a spoken name', () => {
        const root = mount(<div><StatusTile status="modified" /><StatusTile status="deleted" /><StatusTile status="untracked" /></div>);
        const tiles = all(root, 'ag-status-tile', 'root');
        expect(tiles.map((t) => [t.textContent, t.getAttribute('data-tone'), t.getAttribute('aria-label')])).toEqual([['M', 'working', 'Modified'], ['D', 'failed', 'Deleted'], ['?', 'dim', 'Untracked']]);
    });

    it('splits paths and writes sizes', () => {
        expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b', name: 'c.ts' });
        expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
        expect(fileSizeText(812)).toBe('812 B');
        expect(fileSizeText(3 * 1024 * 1024)).toBe('3.0 MB');
    });
});

describe('asking about a line', () => {
    it('sends the trimmed question on Send or Ctrl+Enter, cancels on Escape, and stays disabled while empty', async () => {
        const sent: string[] = [];
        let cancelled = 0;
        const root = mount(<LineComposer agent={{ name: 'Forge', hue: 2 }} line={61} fileRef="shell.css:61" note="Posts to “Mobile pass #47” with the file, line and hunk attached" onSend={(t) => sent.push(t)} onCancel={() => { cancelled++; }} />);
        expect(one(root, 'ag-line-composer', 'title')!.textContent).toBe('Ask Forge about line 61');
        expect(one(root, 'ag-line-composer', 'ref')!.textContent).toBe('shell.css:61');
        const send = buttonNamed(root, 'Send to chat');
        expect(send.disabled).toBe(true);
        const input = one(root, 'ag-line-composer', 'input') as HTMLTextAreaElement;
        expect(document.activeElement).toBe(input);
        input.value = '  Does the drawer keep its focus trap?  ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(send.disabled).toBe(false);
        send.click();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        expect(sent).toEqual(['Does the drawer keep its focus trap?', 'Does the drawer keep its focus trap?']);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        buttonNamed(root, 'Cancel').click();
        expect(cancelled).toBe(2);
    });
});

describe('Go to file', () => {
    const PATHS = ['packages/ui/src/shell/shell.css', 'packages/ui/src/shell/Drawer.tsx', 'packages/core/src/workdir.ts', 'README.md'];

    it('ranks file-name matches first', () => {
        expect(findPaths(PATHS, 'drawer')).toEqual(['packages/ui/src/shell/Drawer.tsx']);
        expect(findPaths(PATHS, 'shcss')[0]).toBe('packages/ui/src/shell/shell.css');
        expect(findPaths(PATHS, 'zzz')).toEqual([]);
        expect(findPaths(PATHS, '')).toEqual([]);
    });

    it('lists matches as a listbox, moves with the arrows, and picks with Enter', async () => {
        const picked: string[] = [];
        const root = mount(<GoToFile paths={PATHS} onPick={(p) => picked.push(p)} hotkey />);
        const input = one(root, 'ag-find', 'input') as HTMLInputElement;
        input.value = 'src';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        const results = all(root, 'ag-find', 'result');
        expect(results.length).toBe(3);
        expect(input.getAttribute('aria-expanded')).toBe('true');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await tick();
        expect(all(root, 'ag-find', 'result')[1]!.getAttribute('aria-selected')).toBe('true');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(picked).toHaveLength(1);
        expect(one(root, 'ag-find', 'results')).toBeNull();
        // Ctrl+P from anywhere focuses the search.
        (document.activeElement as HTMLElement | null)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
        expect(document.activeElement).toBe(input);
        expect(root.querySelector('kbd')!.textContent).toBe('Ctrl P');
    });
});

describe('the file tree', () => {
    const FOLDERS: Record<string, FsTreeEntry[]> = {
        '': [
            { name: 'packages', path: 'packages', type: 'dir', change: 'modified' },
            { name: 'README.md', path: 'README.md', type: 'file', size: 10 }
        ],
        packages: [{ name: 'ui', path: 'packages/ui', type: 'dir', change: 'modified' }],
        'packages/ui': [
            { name: 'shell.css', path: 'packages/ui/shell.css', type: 'file', change: 'modified' },
            { name: 'drawer.test.ts', path: 'packages/ui/drawer.test.ts', type: 'file', change: 'added' }
        ]
    };

    it('opens the way to the selected file, loading each folder once, with change dots', async () => {
        const loaded: string[] = [];
        const load = async (path: string) => {
            loaded.push(path);
            return FOLDERS[path] ?? [];
        };
        const root = mount(<FileTree load={load} selected="packages/ui/shell.css" onSelect={() => undefined} />);
        await waitFor(() => all(root, 'ag-file-tree', 'item').length === 5);
        expect(loaded.sort()).toEqual(['', 'packages', 'packages/ui']);
        const items = all(root, 'ag-file-tree', 'item');
        expect(items.map((i) => i.getAttribute('data-path'))).toEqual(['packages', 'packages/ui', 'packages/ui/shell.css', 'packages/ui/drawer.test.ts', 'README.md']);
        expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '3', '3', '1']);
        const selected = items[2]!;
        expect(selected.getAttribute('aria-selected')).toBe('true');
        expect(selected.getAttribute('tabindex')).toBe('0');
        expect(selected.querySelector('[data-part="dot"]')!.getAttribute('data-tone')).toBe('working');
        expect(items[3]!.querySelector('[data-part="dot"]')!.getAttribute('data-tone')).toBe('live');
        expect(one(root, 'ag-file-tree', 'root')!.getAttribute('role')).toBe('tree');
    });

    it('expands folders on click, picks files, and moves with the keyboard', async () => {
        const picked: string[] = [];
        const root = mount(<FileTree load={async (p) => FOLDERS[p] ?? []} onSelect={(e) => picked.push(e.path)} />);
        await waitFor(() => all(root, 'ag-file-tree', 'item').length === 2);
        const packages = all(root, 'ag-file-tree', 'item')[0]!;
        expect(packages.getAttribute('aria-expanded')).toBe('false');
        packages.click();
        await waitFor(() => all(root, 'ag-file-tree', 'item').length === 3);
        expect(packages.getAttribute('aria-expanded')).toBe('true');
        // Right on the open "ui" row's parent moves down; Right on "ui" opens it.
        const tree = one(root, 'ag-file-tree', 'root')!;
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await waitFor(() => all(root, 'ag-file-tree', 'item').length === 5);
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(picked).toEqual(['packages/ui/shell.css']);
        all(root, 'ag-file-tree', 'item').find((i) => i.getAttribute('data-path') === 'README.md')!.click();
        expect(picked).toEqual(['packages/ui/shell.css', 'README.md']);
    });

    it('shows a folder that failed to load, and the legend', async () => {
        const root = mount(<div><FileTree load={() => Promise.reject(new Error('Machine disconnected'))} onSelect={() => undefined} /><FileTreeLegend ignoredHidden /></div>);
        await waitFor(() => one(root, 'ag-file-tree', 'status')?.textContent === 'Machine disconnected');
        expect(one(root, 'ag-file-tree', 'legend')!.textContent).toBe('changedadded.gitignore hidden');
        expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    });
});

describe('the Monaco theme', () => {
    it('is built from the design system\'s palette, with the 8 % diff tints', () => {
        const theme = monacoTheme();
        expect(theme.name).toBe('control-room');
        expect(theme.data.colors['editor.background']).toBe(palette['base-100']);
        expect(theme.data.colors['editorLineNumber.foreground']).toBe(palette['text-dim']);
        expect(theme.data.colors['diffEditor.insertedLineBackground']).toBe(withAlpha(palette.live, 0.08));
        expect(theme.data.colors['diffEditor.removedLineBackground']).toBe(`${palette.failed}14`);
        // Another palette, another theme — no colour is written in the renderer.
        const other = monacoTheme({ ...palette, 'base-100': '#FFFFFF' });
        expect(other.data.colors['editor.background']).toBe('#FFFFFF');
    });
});

describe('the session files scopes in the design system', () => {
    const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;

    it('are in the fragment, each with a recipe that styles only declared parts, and validate with no warnings', () => {
        for (const anatomy of codeAnatomies) {
            expect(fragment.components.some((c) => c.scope === anatomy.scope), anatomy.scope).toBe(true);
            const recipe = codeRecipes.find((r) => r.component === anatomy.scope);
            expect(recipe, anatomy.scope).toBeDefined();
            const parts = new Set<string>(anatomy.partNames());
            for (const part of Object.keys(recipe!.parts)) expect(parts.has(part), `${anatomy.scope}.${part}`).toBe(true);
        }
        expect(tokens.scopes?.['ag-status-tile']).toEqual(codeScopes['ag-status-tile']);
        const result = validateDesignSystem(designSystem, mergeManifests(zeroManifest, fragment));
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
    });
});
