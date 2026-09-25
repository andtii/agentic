import type { Ref } from '../src/index';
import { formatRef, parseRef, parseRefs } from '../src/index';

describe('refs (#748)', () => {
    // docs/design/projects/HANDOFF.md, "Agent tools and refs" — the ref syntax examples.
    const examples: [string, Ref][] = [
        ['#9', { kind: 'item', n: 9 }],
        ['signalx#14', { kind: 'project-item', project: 'signalx', n: 14 }],
        ['@lint', { kind: 'member', handle: 'lint' }],
        ['path/file.ts:38-41', { kind: 'file', path: 'path/file.ts', from: 38, to: 41 }],
        ['pr:604', { kind: 'pr', n: 604 }],
        ['4f2a9c1', { kind: 'commit', sha: '4f2a9c1' }],
        ['chat:msg-42', { kind: 'chat', messageId: 'msg-42' }],
        ['doc:architecture.md#7', { kind: 'doc', path: 'architecture.md', section: '7' }],
        ['https://github.com/andtii/agentic/pull/604', { kind: 'url', url: 'https://github.com/andtii/agentic/pull/604' }],
        // canonical extras
        ['packages/platform/src/registry/manifest.ts:12-60@4f2a9c1', { kind: 'file', path: 'packages/platform/src/registry/manifest.ts', from: 12, to: 60, sha: '4f2a9c1' }],
        ['plugins/model.ts:7', { kind: 'file', path: 'plugins/model.ts', from: 7, to: 7 }],
        ['doc:docs/architecture.md', { kind: 'doc', path: 'docs/architecture.md' }],
    ];

    it.each(examples)('round-trips %s', (text, ref) => {
        expect(parseRef(text)).toEqual(ref);
        expect(formatRef(ref)).toBe(text);
        expect(parseRef(formatRef(ref))).toEqual(ref);
    });

    it('finds every example inside prose, with offsets', () => {
        const text = examples.map(([t]) => t).join(' and ');
        const found = parseRefs(text);
        expect(found.map((m) => m.ref)).toEqual(examples.map(([, r]) => r));
        for (const m of found) expect(text.slice(m.start, m.end)).toBe(m.text);
    });

    it('drops sentence punctuation and unbalanced parens', () => {
        const found = parseRefs('Fixed #9, see (https://x.dev/a_(b)) and @lint. Then pr:604; done (4f2a9c1).');
        expect(found.map((m) => m.text)).toEqual(['#9', 'https://x.dev/a_(b)', '@lint', 'pr:604', '4f2a9c1']);
    });

    it('leaves look-alikes alone', () => {
        expect(parseRefs('mail a@b.com at 14:52, id 1234567, word defaced, x#y, #9x, v2#, pr:x, 2026-09-25')).toEqual([]);
    });

    it('reads a scoped package path as a file, not a member', () => {
        expect(parseRef('@sigx/zero/src/index.ts:3-4')).toEqual({ kind: 'file', path: '@sigx/zero/src/index.ts', from: 3, to: 4 });
    });

    it('rejects an inverted or zero line range', () => {
        expect(parseRefs('a/b.ts:9-3 a/b.ts:0')).toEqual([]);
    });

    it('parseRef wants exactly one ref', () => {
        expect(parseRef('  #9  ')).toEqual({ kind: 'item', n: 9 });
        expect(parseRef('#9 #10')).toBeNull();
        expect(parseRef('see #9')).toBeNull();
        expect(parseRef('')).toBeNull();
    });

    it('formatRef leaves a url title out', () => {
        expect(formatRef({ kind: 'url', url: 'https://x.dev', title: 'X' })).toBe('https://x.dev');
    });
});
