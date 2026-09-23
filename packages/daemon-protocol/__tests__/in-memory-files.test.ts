import { answerFilesOp, IN_MEMORY_PLAIN_ROOT, IN_MEMORY_PROJECT_ROOT, IN_MEMORY_SESSION_FOLDERS, inMemoryEnvironment } from '../src/testing/index';

const env = inMemoryEnvironment();
const ask = (op: Parameters<typeof answerFilesOp>[2]) => answerFilesOp(IN_MEMORY_SESSION_FOLDERS, env, op);

describe("the in-memory daemon's session folders (#559)", () => {
    it('lists one level, folders first, ignored entries hidden, changes marked', () => {
        const top = ask({ kind: 'tree', root: IN_MEMORY_PROJECT_ROOT, path: '' });
        expect(top.result).toEqual({
            kind: 'tree',
            root: IN_MEMORY_PROJECT_ROOT,
            path: '',
            entries: [
                { name: 'src', path: 'src', type: 'dir', change: 'modified' },
                { name: 'README.md', path: 'README.md', type: 'file', size: 10 }
            ],
            truncated: false,
            ignoredHidden: true
        });
        expect(ask({ kind: 'tree', root: IN_MEMORY_PROJECT_ROOT, path: 'src' }).result).toMatchObject({ entries: [{ name: 'app.ts', type: 'file', change: 'modified' }] });
        expect(ask({ kind: 'tree', root: IN_MEMORY_PROJECT_ROOT, path: 'nope' }).error?.code).toBe('not-found');
    });

    it('reads a file at working, head and base', () => {
        expect(ask({ kind: 'read', root: IN_MEMORY_PROJECT_ROOT, path: 'src/app.ts' }).result).toMatchObject({ rev: 'working', lines: 2 });
        expect(ask({ kind: 'read', root: IN_MEMORY_PROJECT_ROOT, path: 'src/app.ts', rev: 'head' }).result).toMatchObject({ text: 'export const answer = 41;\n', lines: 1 });
        expect(ask({ kind: 'read', root: IN_MEMORY_PROJECT_ROOT, path: 'src/app.ts', rev: 'base' }).error?.code).toBe('not-found');
        expect(ask({ kind: 'read', root: IN_MEMORY_PLAIN_ROOT, path: 'notes.txt', rev: 'head' }).error?.code).toBe('not-a-repo');
    });

    it('answers uncommitted and branch change sets', () => {
        const uncommitted = ask({ kind: 'changes', root: IN_MEMORY_PROJECT_ROOT, scope: 'uncommitted' }).result;
        expect(uncommitted).toMatchObject({ kind: 'changes', vcs: 'git', scope: 'uncommitted', branch: 'feature/files', base: 'main', ahead: 1, behind: 0 });
        expect(uncommitted?.kind === 'changes' && uncommitted.files).toEqual([
            { path: 'dist/out.js', status: 'untracked', added: 1, removed: 0 },
            { path: 'old.txt', status: 'deleted', added: 0, removed: 1 },
            { path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }
        ]);
        const branch = ask({ kind: 'changes', root: IN_MEMORY_PROJECT_ROOT, scope: 'branch' }).result;
        expect(branch?.kind === 'changes' && branch.files).toEqual([{ path: 'src/app.ts', status: 'added', added: 1, removed: 0 }]);
        expect(branch?.kind === 'changes' && branch.commits.map((c) => c.short)).toEqual(['c0ffee0']);
        expect(ask({ kind: 'changes', root: IN_MEMORY_PLAIN_ROOT, scope: 'uncommitted' }).error?.code).toBe('not-a-repo');
    });

    it('refuses a root outside the working roots and a path climbing out of root', () => {
        expect(ask({ kind: 'tree', root: '/elsewhere', path: '' }).error?.code).toBe('outside-roots');
        expect(ask({ kind: 'read', root: IN_MEMORY_PROJECT_ROOT, path: '../plain/notes.txt' }).error?.code).toBe('outside-roots');
        expect(ask({ kind: 'read', root: IN_MEMORY_PROJECT_ROOT, path: '/work/plain/notes.txt' }).error?.code).toBe('outside-roots');
        expect(ask({ kind: 'tree', root: '/work/missing', path: '' }).error?.code).toBe('not-found');
    });

    it('answers binary files with metadata only and refuses a text over the limit', () => {
        const folders = [{ root: '/work/bin', files: { 'a.bin': 'PK\u0003\u0004', 'big.txt': 'x'.repeat(480 * 1024 + 1) } }];
        expect(answerFilesOp(folders, env, { kind: 'read', root: '/work/bin', path: 'a.bin' }).result).toEqual({ kind: 'read', path: 'a.bin', rev: 'working', size: 4, binary: true });
        expect(answerFilesOp(folders, env, { kind: 'read', root: '/work/bin', path: 'big.txt' }).error?.code).toBe('too-large');
    });
});
