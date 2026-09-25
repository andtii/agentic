/**
 * Origin → `{provider, repo}` (#741): the folder's identity (`identityOf`, its origin remote) read as the repo a
 * pull request adapter works on, for every remote form git writes.
 */
import type { ProjectFolderInfo } from '@agentic/core';
import { describe, expect, it } from 'vitest';

import { isPullRepo, pullRepoOf, pullRepoOfOrigin } from '../../src/provider/index';

describe('pullRepoOfOrigin', () => {
    it.each([
        ['https://github.com/andtii/agentic.git'],
        ['https://github.com/andtii/agentic'],
        ['https://github.com/andtii/agentic/'],
        ['https://x-access-token@github.com/andtii/agentic.git'],
        ['git@github.com:andtii/agentic.git'],
        ['github.com:andtii/agentic'],
        ['ssh://git@github.com/andtii/agentic.git'],
        ['ssh://git@github.com:22/andtii/agentic.git'],
        ['  https://GitHub.com/andtii/agentic.git  ']
    ])('%s → github andtii/agentic', (origin) => {
        expect(pullRepoOfOrigin(origin)).toEqual({ provider: 'github', repo: 'andtii/agentic' });
    });

    it('keeps dots, dashes and underscores in names', () => {
        expect(pullRepoOfOrigin('git@github.com:sigx-js/zero.ui_kit.git')).toEqual({ provider: 'github', repo: 'sigx-js/zero.ui_kit' });
    });

    it('is undefined for a host no adapter reads, a local path, or a path that is not owner/name', () => {
        expect(pullRepoOfOrigin('https://gitlab.com/a/b.git')).toBeUndefined();
        expect(pullRepoOfOrigin('C:\\repos\\agentic')).toBeUndefined();
        expect(pullRepoOfOrigin('/srv/git/agentic.git')).toBeUndefined();
        expect(pullRepoOfOrigin('https://github.com/andtii')).toBeUndefined();
        expect(pullRepoOfOrigin('https://github.com/a/b/c')).toBeUndefined();
        expect(pullRepoOfOrigin('not a url')).toBeUndefined();
    });

    it('reads an Enterprise host when given one', () => {
        expect(pullRepoOfOrigin('git@ghe.example.com:team/app.git', { 'ghe.example.com': 'github' })).toEqual({ provider: 'github', repo: 'team/app' });
    });
});

describe('pullRepoOf', () => {
    it('reads the folder identity', () => {
        const folder = { path: 'C:/Dev/agentic', exists: true, git: { origin: 'git@github.com:andtii/agentic.git' } } as unknown as ProjectFolderInfo;
        expect(pullRepoOf(folder)).toEqual({ provider: 'github', repo: 'andtii/agentic' });
        expect(pullRepoOf({ path: '/tmp/x', exists: true } as unknown as ProjectFolderInfo)).toBeUndefined();
    });
});

describe('isPullRepo', () => {
    it('accepts owner/name only', () => {
        expect(isPullRepo('andtii/agentic')).toBe(true);
        expect(['', 'andtii', 'a/b/c', '../x', 'a/..', 'a b/c'].some(isPullRepo)).toBe(false);
    });
});
