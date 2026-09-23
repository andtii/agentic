/**
 * A session's Changes and Files views (#564) on the mock workspace, and every
 * state row of the handoff's table on a hand-built `SessionFiles`: offline
 * with a snapshot, folder gone, nothing uncommitted, not a repo, an API
 * agent, a diff too large, a binary file. The plain renderer draws the code
 * (happy-dom runs no Monaco).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import type { ChangeSet, WorkspaceSource } from '@agentic/core';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import { memoryWorkspaceSource, mockSessionFolder, type MemoryFolder } from '../../src/mock/files';
import { agentNamed, loadSession } from '../../src/mock/workspace';
import { createServerRouter } from '../../src/router';
import { ChangesView } from '../../src/pages/SessionChanges';
import { FilesView, fileFacts } from '../../src/pages/SessionFiles';
import { changesHref, filesHref, type SessionFiles } from '../../src/pages/session/files';
import { gitBaseOf, mockQuestions } from '../../src/pages/session/files-sources';
import { sessionTabs } from '../../src/pages/session/bar';
import { mountRoute, texts, tick } from './mount';

/** Until a condition holds (the mock source answers on a microtask; the page settles a tick later). */
async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
}

const tabs = (dom: ParentNode) => texts([...dom.querySelectorAll('[data-scope="ag-session-bar"][data-part="tab"]')]);
const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLAnchorElement>('[data-scope="ag-changes"][data-part="item"]')];
const names = (dom: ParentNode) => texts([...dom.querySelectorAll('[data-scope="ag-changes"][data-part="item"] [data-part="name"]')]);

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** Mount one view over a hand-built `SessionFiles`, on the route it belongs to. */
async function mountView(kind: 'changes' | 'files', files: SessionFiles, path = kind === 'changes' ? changesHref('s1') : filesHref('s1')): Promise<HTMLDivElement> {
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const v = loadSession('s1')!;
    const ctx = { v, agent: agentNamed(v.agentId), files };
    const app = defineApp(kind === 'changes' ? <ChangesView ctx={ctx} /> : <FilesView ctx={ctx} />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

const folder47 = (): MemoryFolder => mockSessionFolder('C:\\Dev\\agentic\\branches\\47-mobile-drawer')!;
const filesOf = (source: WorkspaceSource | null, extra: Partial<SessionFiles> = {}): SessionFiles => ({
    sessionId: 's1', root: 'C:\\Dev\\agentic\\branches\\47-mobile-drawer', files: true, vcs: true, source, machineName: 'alien01', online: true, time: () => '14:09', ...extra
});

describe('the session bar', () => {
    it('shows Transcript, Changes n and Files with the branch and how far ahead it is, on the Transcript page too', async () => {
        const dom = await mountRoute('/sessions/s1');
        await until(() => tabs(dom).some((t) => t.startsWith('Changes3')), 'the changes count');
        expect(tabs(dom)).toEqual(['Transcript', 'Changes3', 'Files']);
        const bar = dom.querySelector('[data-scope="ag-session-bar"][data-part="root"]')!;
        expect(bar.querySelector('[data-part="tab"][aria-current="page"]')!.textContent).toBe('Transcript');
        expect(bar.querySelector('[data-part="env"]')!.textContent).toBe('alien01 / work');
        expect(bar.querySelector('[data-part="branch"]')!.textContent).toBe('47-mobile-drawer');
        expect(bar.querySelector('[data-part="ahead"]')!.textContent).toBe('2 ahead of main');
    });

    it('hides both tabs for an API agent, and Changes for a folder under no VCS', () => {
        expect(sessionTabs('s3', filesOf(null, { files: false }), 'transcript').map((t) => t.id)).toEqual(['transcript']);
        expect(sessionTabs('s1', filesOf(null, { vcs: false }), 'files').map((t) => t.id)).toEqual(['transcript', 'files']);
        expect(sessionTabs('s1', filesOf(null), 'changes').map((t) => [t.id, t.current])).toEqual([['transcript', false], ['changes', true], ['files', false]]);
    });

    it('names the trail Agents › Forge › Sessions › s_41aa › Changes', () => {
        const route = { name: 'session-changes', path: '/sessions/s1/changes', params: { id: 's1' } };
        const trail = trailFor(route, topbarFor(route));
        expect(trail.map((c) => c.label)).toEqual(['Agents', 'Forge', 'Sessions', 's_41aa', 'Changes']);
        expect(trail.at(-2)!.href).toBe('/sessions/s1');
        expect(trail.at(-1)!.current).toBe(true);
    });
});

describe('/sessions/:id/changes', () => {
    it('lists the uncommitted files and the commits on the branch, and opens the first file', async () => {
        const dom = await mountRoute('/sessions/s1/changes');
        await until(() => rows(dom).length === 3, 'the change list');
        expect(names(dom)).toEqual(['shell.css', 'Drawer.tsx', 'drawer.test.ts']);
        expect(texts([...dom.querySelectorAll('[data-scope="ag-changes"] [data-scope="ag-status-tile"]')])).toEqual(['M', 'M', 'A']);
        expect(texts([...dom.querySelectorAll('[data-scope="ag-changes"][data-part="subject"]')])).toEqual(['shell: drawer state on data-l-drawer', 'shell: extract breakpoint token']);
        expect(rows(dom)[0]!.getAttribute('aria-current')).toBe('true');
        expect(rows(dom)[1]!.getAttribute('href')).toBe('/sessions/s1/changes?file=packages%2Fui%2Fsrc%2Fshell%2FDrawer.tsx');
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="diff"]') !== null, 'the diff');
        const diff = dom.querySelector('[data-scope="ag-code"][data-kind="diff"]')!;
        expect(diff.getAttribute('data-mode')).toBe('unified');
        expect(diff.textContent).toContain('grid-template-columns: var(--drawer-w, 232px) minmax(0, 1fr);');
        expect(dom.querySelector('[data-scope="ag-file-header"] [data-part="name"]')!.textContent).toBe('shell.css');
        expect(dom.querySelector('[data-scope="ag-changes"][data-part="note"]')!.textContent).toContain('Files stay on alien01');
    });

    it('follows the query: another file, split view, the branch scope', async () => {
        const dom = await mountRoute(changesHref('s1', { file: 'packages/ui/src/shell/Drawer.tsx', view: 'split' }));
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="diff"]') !== null, 'the diff');
        expect(dom.querySelector('[data-scope="ag-file-header"] [data-part="name"]')!.textContent).toBe('Drawer.tsx');
        expect(dom.querySelector('[data-scope="ag-code"][data-kind="diff"]')!.getAttribute('data-mode')).toBe('split');
        const branch = await mountRoute(changesHref('s1', { scope: 'branch' }));
        await until(() => names(branch).length === 2, 'the branch list');
        expect(names(branch)).toEqual(['Drawer.tsx', 'breakpoints.css']);
        expect(texts([...branch.querySelectorAll('[data-scope="ag-changes"][data-part="label"]')])[0]).toBe('Branch vs main');
    });

    it('asks about a line: the number opens the composer under it, Send hands the question and its hunk to the seam', async () => {
        mockQuestions.length = 0;
        const dom = await mountRoute('/sessions/s1/changes');
        await until(() => dom.querySelector('[data-scope="ag-code"][data-part="num"]') !== null && dom.querySelector('button[data-scope="ag-code"][data-part="num"]') !== null, 'the line numbers');
        const line = [...dom.querySelectorAll<HTMLButtonElement>('button[data-scope="ag-code"][data-part="num"]')].find((b) => b.closest('[data-part="row"]')?.getAttribute('data-tone') === 'failed')!;
        line.click();
        await until(() => dom.querySelector('[data-scope="ag-line-composer"][data-part="root"]') !== null, 'the composer');
        const form = dom.querySelector<HTMLFormElement>('[data-scope="ag-line-composer"][data-part="root"]')!;
        expect(form.textContent).toContain('Ask Forge about line');
        expect(form.textContent).toContain('Posts to “Mobile pass #47” with the file, line and hunk attached');
        const input = form.querySelector('textarea')!;
        input.value = 'Does the drawer keep its focus trap?';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => mockQuestions.length === 1, 'the question');
        expect(mockQuestions[0]!.path).toBe('packages/ui/src/shell/shell.css');
        expect(mockQuestions[0]!.ref.side).toBe('original');
        expect(mockQuestions[0]!.hunk).toMatch(/^@@ /);
        expect(mockQuestions[0]!.hunk).toContain('-  grid-template-columns: 232px 1fr;');
        await until(() => dom.querySelector('[data-scope="ag-line-composer"]') === null, 'the composer to close');
        expect(dom.querySelector('[data-files-sent]')!.textContent).toBe(`Asked Forge about shell.css:${mockQuestions[0]!.ref.line}`);
    });

    it('draws no line buttons without the ask seam', async () => {
        const dom = await mountView('changes', filesOf(memoryWorkspaceSource(folder47())));
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="diff"]') !== null, 'the diff');
        expect(dom.querySelector('button[data-scope="ag-code"][data-part="num"]')).toBeNull();
    });

    it('with nothing uncommitted, says so and shows the branch', async () => {
        const dom = await mountRoute('/sessions/s4/changes');
        await until(() => dom.querySelector('[data-changes-empty]') !== null, 'the empty note');
        expect(dom.querySelector('[data-changes-empty]')!.textContent).toBe('No uncommitted changes');
        expect(dom.querySelector('[data-scope="ag-segmented"], [data-segmented]')).not.toBeNull();
        expect(dom.textContent).toContain('Nothing on this branch yet');
    });

    it('an API agent session has no folder to show', async () => {
        const dom = await mountRoute('/sessions/s3/changes');
        expect(dom.textContent).toContain('This session has no folder');
        expect(tabs(dom)).toEqual(['Transcript']);
    });

    it('a folder under no VCS: no Changes tab, and the view points to Files', async () => {
        const plain: MemoryFolder = { files: { 'notes.txt': { working: 'hello\n' } } };
        const dom = await mountView('changes', filesOf(memoryWorkspaceSource(plain), { vcs: undefined }));
        await until(() => dom.textContent!.includes('Not a git repository'), 'the not-a-repo state');
        expect(tabs(dom)).toEqual(['Transcript', 'Files']);
        expect(dom.querySelector('a[href="/sessions/s1/files"]')).not.toBeNull();
    });

    it('offline: the last snapshot with its time under a Machine disconnected banner, refresh disabled', async () => {
        const snapshot: ChangeSet = { kind: 'changes', vcs: 'git', scope: 'uncommitted', branch: '47-mobile-drawer', base: 'main', ahead: 2, files: [{ path: 'a/b.ts', status: 'modified', added: 1, removed: 1 }], commits: [], truncated: false };
        const dom = await mountView('changes', filesOf(null, { online: false, snapshot: async (scope) => (scope === 'uncommitted' ? { at: 1, result: snapshot } : null) }));
        await until(() => names(dom).length === 1, 'the snapshot');
        expect(dom.querySelector('[data-files-banner]')!.textContent).toContain('Machine disconnected · showing what alien01 last reported at 14:09');
        expect(dom.querySelector<HTMLButtonElement>('button[aria-label^="Refresh"]')!.disabled).toBe(true);
        expect(dom.textContent).toContain('it shows again when the machine reconnects');
    });

    it('a worktree that is gone: "Folder no longer on alien01"', async () => {
        const gone: WorkspaceSource = { ...memoryWorkspaceSource(folder47()), changes: async () => ({ error: { code: 'not-found', message: 'gone' } }) };
        const dom = await mountView('changes', filesOf(gone));
        await until(() => dom.querySelector('[data-files-banner][data-tone="failed"]') !== null, 'the banner');
        expect(dom.querySelector('[data-files-banner][data-tone="failed"]')!.textContent).toBe('Folder no longer on alien01');
    });

    it('a diff too large links to Files; a binary file shows metadata only', async () => {
        const big: WorkspaceSource = { ...memoryWorkspaceSource(folder47()), read: async () => ({ error: { code: 'too-large', message: '2.4 MB' } }) };
        const dom = await mountView('changes', filesOf(big));
        await until(() => dom.querySelector('[data-files-state="too-large"]') !== null, 'the too-large state');
        expect(dom.querySelector('[data-files-state="too-large"] a')!.getAttribute('href')).toBe(filesHref('s1', 'packages/ui/src/shell/shell.css'));
        const f = folder47();
        const withBinary: MemoryFolder = { ...f, files: { ...f.files, 'packages/ui/src/assets/drawer.png': { head: '\u0000png', working: '\u0000png2', binary: true } } };
        const bin = await mountView('changes', filesOf(memoryWorkspaceSource(withBinary)), changesHref('s1', { file: 'packages/ui/src/assets/drawer.png' }));
        await until(() => bin.textContent!.includes('nothing to diff'), 'the binary note');
        expect(bin.textContent).toContain('Binary file · 5 B — nothing to diff.');
    });
});

describe('/sessions/:id/files', () => {
    it('lists the folder with change dots, opens a deep link, and reads the file with its change stripes', async () => {
        const dom = await mountRoute(filesHref('s1', 'packages/ui/src/shell/shell.css'));
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="viewer"]') !== null, 'the viewer');
        const items = [...dom.querySelectorAll<HTMLElement>('[data-scope="ag-file-tree"][data-part="item"]')];
        expect(items.slice(0, 3).map((i) => i.dataset['path'])).toEqual(['apps', 'docs', 'packages']);
        const shell = items.find((i) => i.dataset['path'] === 'packages/ui/src/shell/shell.css')!;
        expect(shell.getAttribute('aria-selected')).toBe('true');
        expect(shell.querySelector('[data-part="dot"]')!.getAttribute('data-tone')).toBe('working');
        expect(items.find((i) => i.dataset['path'] === 'packages/ui/src/shell/drawer.test.ts')!.querySelector('[data-part="dot"]')!.getAttribute('data-tone')).toBe('live');
        expect(items.find((i) => i.dataset['path'] === 'packages/ui/src/shell/index.ts')!.querySelector('[data-part="dot"]')).toBeNull();
        const stripes = [...dom.querySelectorAll('[data-scope="ag-code"][data-part="stripe"][data-tone="working"]')];
        expect(stripes.length).toBeGreaterThan(5);
        expect(dom.querySelector('[data-scope="ag-file-header"][data-part="facts"]')!.textContent).toMatch(/^\d+ lines · \d+\.\d KB$/);
        const links = [...dom.querySelectorAll<HTMLAnchorElement>('[data-scope="ag-file-header"] a[href]')];
        expect(links.find((a) => a.textContent === 'Open diff')!.getAttribute('href')).toBe(changesHref('s1', { file: 'packages/ui/src/shell/shell.css' }));
        // #565: the mock chat's Edit call wrote this file, and the file can be mentioned in that chat.
        expect(dom.querySelector('[data-file-edited]')!.textContent).toMatch(/^Edited byFOEdit at \d\d:\d\d$/);
        expect(dom.querySelector('[data-file-edited] a')!.getAttribute('href')).toBe('/chats/c1');
        expect(dom.textContent).toContain('Mention in chat');
        expect(dom.querySelector('[data-scope="ag-file-tree"][data-part="legend"]')!.textContent).toContain('.gitignore hidden');
        expect(dom.querySelector('[data-files-root]')!.textContent).toContain('C:/Dev/agentic/branches/47-mobile-drawer');
    });

    it('offers Mention in chat when the seam is there, and hands it the path', async () => {
        const mentioned: string[] = [];
        const dom = await mountView('files', filesOf(memoryWorkspaceSource(folder47()), { mention: (p) => mentioned.push(p) }), filesHref('s1', 'README.md'));
        await until(() => dom.querySelector('[data-scope="ag-code"][data-kind="viewer"]') !== null, 'the viewer');
        [...dom.querySelectorAll('button')].find((b) => b.textContent?.includes('Mention in chat'))!.click();
        expect(mentioned).toEqual(['README.md']);
    });

    it('an API agent session has no folder; an offline machine says so', async () => {
        const api = await mountRoute('/sessions/s3/files');
        expect(api.textContent).toContain('This session has no folder');
        const off = await mountView('files', filesOf(memoryWorkspaceSource(folder47()), { online: false }), filesHref('s1', 'README.md'));
        expect(off.querySelector('[data-files-banner]')!.textContent).toContain('Machine disconnected');
        expect(off.querySelector<HTMLButtonElement>('button[aria-label^="Refresh"]')!.disabled).toBe(true);
    });

    it('counts lines and bytes in the header', () => {
        expect(fileFacts(82, 2150)).toBe('82 lines · 2.1 KB');
        expect(fileFacts(1, 12)).toBe('1 line · 12 B');
    });
});

describe('where the files come from', () => {
    it("reads the project git feature's base", () => {
        expect(gitBaseOf({ features: { 'agentic.feature.git': { base: 'develop' } } })).toBe('develop');
        expect(gitBaseOf({ features: { 'agentic.feature.git': {} } })).toBeUndefined();
        expect(gitBaseOf(undefined)).toBeUndefined();
    });

    it('the mock folder computes its change set from the texts', async () => {
        const source = memoryWorkspaceSource(folder47());
        const set = (await source.changes('uncommitted')).result!;
        expect(set.files.map((f) => [f.path.split('/').pop(), f.status])).toEqual([['shell.css', 'modified'], ['Drawer.tsx', 'modified'], ['drawer.test.ts', 'added']]);
        expect(set.files[2]).toMatchObject({ added: 3, removed: 0 });
        expect((await source.read('nope.txt')).error!.code).toBe('not-found');
        expect((await source.tree('')).result!.entries.map((e) => e.name)).toEqual(['apps', 'docs', 'packages', 'AGENTS.md', 'package.json', 'README.md']);
    });

    it('a folder under no VCS lists everything with no change marks and no ignore filter', async () => {
        const plain = memoryWorkspaceSource({ ignored: ['dist'], files: { 'a.txt': { working: 'a\n' }, 'dist/out.js': { working: 'x\n' } } });
        const tree = (await plain.tree('')).result!;
        expect(tree.ignoredHidden).toBe(false);
        expect(tree.entries.map((e) => [e.name, e.change])).toEqual([['dist', undefined], ['a.txt', undefined]]);
    });
});
