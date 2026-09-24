/**
 * Session folders for `pnpm dev:mock` (#564): what the Changes and Files
 * views read when no daemon answers. `memoryWorkspaceSource` is a generic
 * in-memory `WorkspaceSource` over a folder model — each file's text at
 * `base`, `head` and in the working tree — so the change sets, counts and
 * tree marks are computed, never written twice. The fixture for `s1`
 * (Forge on alien01, `47-mobile-drawer`) is the `Changes` / `Files` boards'
 * sample: three uncommitted files and two commits ahead of main.
 */
import { diffLines } from '@agentic/ui';
import type { ChangeCommit, ChangedFile, ChangeScope, ChangeSet, FileChangeStatus, FsReadRev, FsTreeEntry, FsWorktreesResult, WorkspaceAnswer, WorkspaceSource } from '@agentic/core';

/** One file of a folder model: its text per revision; `null` (or absent) where it does not exist. */
export interface MemoryFile {
    readonly base?: string | null;
    readonly head?: string | null;
    readonly working?: string | null;
    /** Not yet known to the VCS (`?`), rather than added. */
    readonly untracked?: boolean;
    readonly binary?: boolean;
}

export interface MemoryFolder {
    readonly files: Readonly<Record<string, MemoryFile>>;
    /** Absent: the folder is not under version control (`changes` answers `not-a-repo`). */
    readonly vcs?: {
        readonly branch: string;
        readonly head: string;
        readonly base: string;
        readonly commits: readonly ChangeCommit[];
    };
    /** `tree` hides these (as `.gitignore` would) and says so. */
    readonly ignored?: readonly string[];
}

const counts = (from: string | null | undefined, to: string | null | undefined): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const op of diffLines(from ?? '', to ?? '')) {
        if (op.kind === 'added') added++;
        else if (op.kind === 'removed') removed++;
    }
    return { added, removed };
};

function statusOf(file: MemoryFile, from: 'base' | 'head', to: 'head' | 'working'): FileChangeStatus | undefined {
    const a = file[from] ?? null;
    const b = file[to] ?? null;
    if (a === null && b === null) return undefined;
    if (a === null) return file.untracked && to === 'working' ? 'untracked' : 'added';
    if (b === null) return 'deleted';
    return a === b ? undefined : 'modified';
}

const textOf = (file: MemoryFile, rev: FsReadRev): string | null => (rev === 'working' ? (file.working ?? null) : rev === 'head' ? (file.head ?? null) : (file.base ?? null));

/** A `WorkspaceSource` over a folder model, answering like a daemon: `not-found`, `not-a-repo`, metadata for binaries. */
export function memoryWorkspaceSource(folder: MemoryFolder): WorkspaceSource {
    const paths = Object.keys(folder.files);
    const ignored = folder.ignored ?? [];
    const changesOf = (scope: ChangeScope): ChangedFile[] => paths.flatMap((path) => {
        const file = folder.files[path]!;
        const [from, to] = scope === 'uncommitted' ? (['head', 'working'] as const) : (['base', 'head'] as const);
        const status = statusOf(file, from, to);
        if (!status) return [];
        return [{ path, status, ...(file.binary ? { binary: true as const } : counts(file[from], file[to])) }];
    });
    const answer = <R>(result: R): Promise<WorkspaceAnswer<R>> => Promise.resolve({ result });
    const fail = <R>(code: 'not-found' | 'not-a-repo', message: string): Promise<WorkspaceAnswer<R>> => Promise.resolve({ error: { code, message } });
    return {
        tree(path) {
            const prefix = path ? `${path}/` : '';
            // Only a folder under version control has an ignore file and change marks, as the daemon answers.
            const vcs = folder.vcs !== undefined;
            const hidden = (p: string): boolean => vcs && ignored.some((i) => p === i || p.startsWith(`${i}/`));
            const live = paths.filter((p) => folder.files[p]!.working != null && !hidden(p));
            if (path && !live.some((p) => p.startsWith(prefix))) return fail('not-found', `${path} does not exist`);
            const uncommitted = new Map(vcs ? changesOf('uncommitted').map((c) => [c.path, c.status]) : []);
            const byName = new Map<string, FsTreeEntry>();
            for (const p of live) {
                if (!p.startsWith(prefix)) continue;
                const rest = p.slice(prefix.length);
                const slash = rest.indexOf('/');
                const name = slash < 0 ? rest : rest.slice(0, slash);
                const entryPath = `${prefix}${name}`;
                if (slash < 0) {
                    const change = uncommitted.get(p);
                    byName.set(name, { name, path: entryPath, type: 'file', size: new TextEncoder().encode(folder.files[p]!.working ?? '').length, ...(change ? { change } : {}) });
                } else {
                    const had = byName.get(name);
                    const change = had?.change ?? uncommitted.get(p);
                    byName.set(name, { name, path: entryPath, type: 'dir', ...(change ? { change: 'modified' as const } : {}) });
                }
            }
            const entries = [...byName.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
            return answer({ kind: 'tree', root: '', path, entries, truncated: false, ignoredHidden: vcs && ignored.length > 0 });
        },
        read(path, rev = 'working') {
            const file = folder.files[path];
            const text = file ? textOf(file, rev) : null;
            if (!file || text === null) return fail('not-found', `${path} does not exist at ${rev}`);
            const size = new TextEncoder().encode(text).length;
            if (file.binary) return answer({ kind: 'read', path, rev, size, binary: true });
            return answer({ kind: 'read', path, rev, size, text, lines: text === '' ? 0 : text.replace(/\n$/, '').split('\n').length });
        },
        changes(scope) {
            if (!folder.vcs) return fail('not-a-repo', 'not under version control');
            const { branch, head, base, commits } = folder.vcs;
            const set: ChangeSet = { kind: 'changes', vcs: 'git', scope, branch, head, base, ahead: commits.length, behind: 0, files: changesOf(scope), commits, truncated: false };
            return answer(set);
        }
    };
}

// ---- the boards' sample: agentic at 47-mobile-drawer ------------------------

const lines = (...ls: string[]): string => `${ls.join('\n')}\n`;
const at = (hh: number, mm: number): number => {
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
};

const SHELL_TOP = [
    '/* The app shell: sidebar, navbar and content (#84). */',
    '@layer components {',
    '',
    ':root {',
    '  --drawer-w: 232px;',
    '  --navbar-h: 60px;',
    '}',
    '',
    ...Array.from({ length: 28 }, (_, i) => (i % 4 === 3 ? '' : `/* layout note ${i + 1} */`)),
    ''
];

const SHELL_HEAD = lines(
    ...SHELL_TOP,
    '.shell {',
    '  display: grid;',
    '  grid-template-columns: 232px 1fr;',
    '  min-height: 100dvh;',
    '}',
    '',
    '.navbar {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 10px;',
    '  height: 60px;',
    '  padding: 0 28px;',
    '  border-bottom: 1px solid var(--ag-line);',
    '}',
    '',
    '.drawer {',
    '  width: 232px;',
    '  flex-shrink: 0;',
    '  background: var(--color-base-200);',
    '  border-right: 1px solid var(--ag-line);',
    '  padding: 20px 14px;',
    '  display: flex;',
    '  flex-direction: column;',
    '}',
    '',
    '.content {',
    '  padding: 28px;',
    '  overflow: auto;',
    '}',
    '}'
);

const SHELL_WORKING = lines(
    ...SHELL_TOP,
    '.shell {',
    '  display: grid;',
    '  grid-template-columns: var(--drawer-w, 232px) minmax(0, 1fr);',
    '  min-height: 100dvh;',
    '}',
    '',
    '[data-l-drawer="closed"] { --drawer-w: 0px; }',
    '',
    '@media (max-width: 767px) {',
    '  .shell { grid-template-columns: minmax(0, 1fr); }',
    '  [data-l-drawer] {',
    '    position: fixed; inset: 0 auto 0 0;',
    '    width: 312px; transform: translateX(-100%);',
    '    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);',
    '  }',
    '  [data-l-drawer="open"] { transform: none; }',
    '}',
    '',
    '.navbar {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 10px;',
    '  height: 60px;',
    '  padding: 0 28px;',
    '  border-bottom: 1px solid var(--ag-line);',
    '}',
    '',
    '.drawer {',
    '  width: var(--drawer-w, 232px);',
    '  overflow: hidden;',
    '  background: var(--color-base-200);',
    '  border-inline-end: 1px solid var(--ag-line);',
    '  padding: 20px 14px;',
    '  display: var(--drawer-display, flex);',
    '  flex-direction: column;',
    '}',
    '',
    '.content {',
    '  padding: 28px;',
    '  overflow: auto;',
    '}',
    '}'
);

const DRAWER_HEAD = lines(
    "import { component } from 'sigx';",
    "import { Navbar } from './Navbar';",
    '',
    '/** The sidebar drawer: fixed at 232 px. */',
    'export const Drawer = component<{ open: boolean }>(({ props, slots }) => () => (',
    '    <aside class="drawer" aria-label="Navigation">',
    '        {slots.default?.()}',
    '    </aside>',
    '));'
);

const DRAWER_BASE = DRAWER_HEAD.replace('fixed at 232 px', 'always open');

const DRAWER_WORKING = lines(
    "import { component } from 'sigx';",
    "import { Navbar } from './Navbar';",
    '',
    '/** The sidebar drawer: `data-l-drawer` carries its state, so CSS alone opens and closes it. */',
    'export const Drawer = component<{ open: boolean }>(({ props, slots }) => () => (',
    '    <aside class="drawer" aria-label="Navigation" data-l-drawer={props.open ? \'open\' : \'closed\'}>',
    '        {slots.default?.()}',
    '    </aside>',
    '));',
    '',
    'export const DRAWER_WIDTH = 312;',
    'export const DRAWER_BREAKPOINT = 767;'
);

const DRAWER_TEST = lines(
    "it('marks the drawer closed below 768 px', () => {",
    "    expect(render(false).getAttribute('data-l-drawer')).toBe('closed');",
    '});'
);

const same = (text: string): MemoryFile => ({ base: text, head: text, working: text });
const small = (name: string): string => lines(`// ${name}`);

const AGENTIC_47: MemoryFolder = {
    vcs: {
        branch: '47-mobile-drawer',
        head: 'a41c9e2',
        base: 'main',
        commits: [
            { id: 'a41c9e2b7d1f', short: 'a41c9e2', subject: 'shell: drawer state on data-l-drawer', at: at(14, 6), author: 'Forge' },
            { id: '7be0d13c0a55', short: '7be0d13', subject: 'shell: extract breakpoint token', at: at(14, 4), author: 'Forge' }
        ]
    },
    ignored: ['node_modules', 'dist'],
    files: {
        'AGENTS.md': same(lines('# agentic — shared agent guide', '', 'Branch first — never work on main.')),
        'README.md': same(lines('# agentic', '', 'The Unified Agent Platform.')),
        'package.json': same(lines('{', '  "name": "agentic",', '  "private": true', '}')),
        'apps/web/package.json': same(lines('{ "name": "@agentic/web" }')),
        'apps/daemon/package.json': same(lines('{ "name": "@agentic/daemon" }')),
        'docs/architecture.md': same(lines('# Architecture')),
        'packages/core/src/index.ts': same(small('core')),
        'packages/platform/src/index.ts': same(small('platform')),
        'packages/ui/package.json': same(lines('{ "name": "@agentic/ui" }')),
        'packages/ui/src/composer/Composer.tsx': same(small('Composer')),
        'packages/ui/src/layout/Stack.tsx': same(small('Stack')),
        'packages/ui/src/thread/Thread.tsx': same(small('Thread')),
        'packages/ui/src/shell/index.ts': same(lines("export * from './Drawer';", "export * from './Navbar';")),
        'packages/ui/src/shell/Navbar.tsx': same(small('Navbar')),
        'packages/ui/src/shell/shell.css': { base: SHELL_HEAD, head: SHELL_HEAD, working: SHELL_WORKING },
        'packages/ui/src/shell/Drawer.tsx': { base: DRAWER_BASE, head: DRAWER_HEAD, working: DRAWER_WORKING },
        'packages/ui/src/shell/drawer.test.ts': { base: null, head: null, working: DRAWER_TEST },
        'packages/ui/src/tokens/breakpoints.css': { base: null, head: lines(':root { --bp-phone: 767px; }'), working: lines(':root { --bp-phone: 767px; }') },
        'packages/ui/src/assets/drawer.png': { base: '\u0000png', head: '\u0000png', working: '\u0000png', binary: true }
    }
};

/** A checkout with nothing uncommitted and nothing ahead: Changes falls back to the branch and says so. */
const AGENTIC_MAIN: MemoryFolder = {
    vcs: { branch: 'main', head: '5572a6c', base: 'main', commits: [] },
    ignored: ['node_modules'],
    files: {
        'AGENTS.md': AGENTIC_47.files['AGENTS.md']!,
        'README.md': AGENTIC_47.files['README.md']!,
        'package.json': AGENTIC_47.files['package.json']!,
        'docs/runbook.md': same(lines('# Runbook'))
    }
};

/** The mock folder behind a session's `cwd`, or `undefined` for a session with no folder (an API agent). */
export function mockSessionFolder(cwd: string): MemoryFolder | undefined {
    if (!cwd || cwd === '—') return undefined;
    if (cwd.endsWith('47-mobile-drawer')) return AGENTIC_47;
    return AGENTIC_MAIN;
}

/** The mock repository's worktrees (#622): `main`, the #47 branch, and a spike outside the working roots. */
const AGENTIC_WORKTREES = [
    { path: 'C:\\Dev\\agentic\\main', branch: 'main', head: '5572a6c' },
    { path: 'C:\\Dev\\agentic\\branches\\47-mobile-drawer', branch: '47-mobile-drawer', head: '9c1e2d4' },
    { path: 'D:\\spikes\\agentic-drawer', head: '1f0a9b3', detached: true as const, outside: true as const }
];

/** The worktrees of the mock repo a session folder is in, the one it is in marked `current`; `undefined` outside it. */
export function mockWorktrees(root: string): WorkspaceAnswer<FsWorktreesResult> | undefined {
    const fold = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '');
    if (!fold(root).startsWith('c:\\dev\\agentic\\')) return undefined;
    const entries = AGENTIC_WORKTREES.map((w) => (fold(root) === fold(w.path) || fold(root).startsWith(`${fold(w.path)}\\`) ? { ...w, current: true as const } : w));
    return { result: { kind: 'worktrees', root, entries, truncated: false } };
}
