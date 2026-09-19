import { normalizePath, originKey, pathWithin, sameOrigin, suggestWorktreePath } from '../src/index';

describe('originKey / sameOrigin (#330)', () => {
    it.each([
        ['https://github.com/andtii/agentic.git', 'github.com/andtii/agentic'],
        ['https://GitHub.com/andtii/agentic/', 'github.com/andtii/agentic'],
        ['git@github.com:andtii/agentic.git', 'github.com/andtii/agentic'],
        ['ssh://git@github.com/andtii/agentic', 'github.com/andtii/agentic'],
        ['https://user:token@github.com/andtii/agentic', 'github.com/andtii/agentic'],
        ['git@github.com:andtii/Agentic', 'github.com/andtii/Agentic'],
        ['https://dev.azure.com/org/project/_git/repo', 'dev.azure.com/org/project/_git/repo'],
        ['  https://github.com/a/b.git  ', 'github.com/a/b'],
        ['', '']
    ])('%s -> %s', (url, key) => {
        expect(originKey(url)).toBe(key);
    });
    it('matches the same repo across URL forms and keeps the path case', () => {
        expect(sameOrigin('https://github.com/andtii/agentic.git', 'git@github.com:andtii/agentic')).toBe(true);
        expect(sameOrigin('https://github.com/andtii/agentic', 'https://github.com/andtii/agentic-fork')).toBe(false);
        expect(sameOrigin('git@github.com:andtii/agentic', 'git@github.com:andtii/Agentic')).toBe(false);
    });
    it('never matches a blank', () => {
        expect(sameOrigin('', '')).toBe(false);
        expect(sameOrigin('  ', 'https://github.com/a/b')).toBe(false);
    });
});

describe('pathWithin', () => {
    describe('windows', () => {
        const roots = ['C:/src', 'D:\\work\\repos\\'];
        it.each([
            ['C:/src', true],
            ['C:\\src', true],
            ['c:\\SRC\\app', true],
            ['C:/src/app/../lib', true],
            ['C:\\src\\.\\app\\\\deep\\', true],
            ['d:/Work/Repos/agentic/main', true],
            ['C:/src2', false],
            ['C:/src-other/app', false],
            ['C:/src/../etc', false],
            ['C:/', false],
            ['E:/src', false],
            ['src/app', false],
            ['\\src\\app', false],
            ['', false]
        ])('%s → %s', (path, expected) => {
            expect(pathWithin(path, roots, 'windows')).toBe(expected);
        });
        it('handles UNC roots by server and share', () => {
            expect(pathWithin('\\\\nas\\share\\proj', ['//NAS/share'], 'windows')).toBe(true);
            expect(pathWithin('\\\\nas\\other\\proj', ['//NAS/share'], 'windows')).toBe(false);
        });
        it('never matches without roots', () => {
            expect(pathWithin('C:/src', [], 'windows')).toBe(false);
        });
    });

    describe('posix', () => {
        const roots = ['/home/me/src/'];
        it.each([
            ['/home/me/src', true],
            ['/home/me/src/app/', true],
            ['/home/me//src/./app', true],
            ['/home/me/src2', false],
            ['/home/me/src/../.ssh', false],
            ['/home/me/SRC/app', false],
            ['home/me/src', false],
            ['C:/home/me/src', false]
        ])('%s → %s', (path, expected) => {
            expect(pathWithin(path, roots, 'linux')).toBe(expected);
        });
        it('darwin follows the same (case-sensitive, lexical) rules', () => {
            expect(pathWithin('/Users/me/src/app', ['/Users/me/src'], 'darwin')).toBe(true);
        });
        it('the filesystem root holds everything', () => {
            expect(pathWithin('/anything/at/all', ['/'], 'linux')).toBe(true);
        });
    });
});

describe('normalizePath', () => {
    it('gives the machine-native form, case kept', () => {
        expect(normalizePath('c:/Src//App/./x/../', 'windows')).toBe('C:\\Src\\App');
        expect(normalizePath('C:\\', 'windows')).toBe('C:\\');
        expect(normalizePath('//nas/share/a', 'windows')).toBe('\\\\nas\\share\\a');
        expect(normalizePath('/home//me/./src/', 'linux')).toBe('/home/me/src');
        expect(normalizePath('/../..', 'linux')).toBe('/');
    });
    it('is null for a relative path', () => {
        expect(normalizePath('src', 'windows')).toBeNull();
        expect(normalizePath('./src', 'linux')).toBeNull();
    });
});

describe('suggestWorktreePath', () => {
    it('puts a worktree of <repo>/main under <repo>/branches', () => {
        expect(suggestWorktreePath('C:\\Dev\\agentic\\main', 'feat/picker', 'windows')).toBe('C:\\Dev\\agentic\\branches\\feat-picker');
        expect(suggestWorktreePath('/home/me/agentic/main/', 'fix-1', 'linux')).toBe('/home/me/agentic/branches/fix-1');
    });
    it('puts a worktree of a worktree beside it', () => {
        expect(suggestWorktreePath('/home/me/agentic/branches/main', 'fix-2', 'linux')).toBe('/home/me/agentic/branches/fix-2');
        expect(suggestWorktreePath('C:/Dev/agentic/branches/47-drawer', '48-next', 'windows')).toBe('C:\\Dev\\agentic\\branches\\48-next');
    });
    it('uses <repo>-worktrees for any other repo', () => {
        expect(suggestWorktreePath('/home/me/src/app', 'feat/a/b', 'linux')).toBe('/home/me/src/app-worktrees/feat-a-b');
        expect(suggestWorktreePath('D:\\code\\Main-app', 'x', 'windows')).toBe('D:\\code\\Main-app-worktrees\\x');
    });
    it('is null for a relative repo', () => {
        expect(suggestWorktreePath('app', 'x', 'linux')).toBeNull();
    });
});
