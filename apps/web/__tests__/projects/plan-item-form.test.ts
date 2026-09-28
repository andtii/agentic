/**
 * The Plan item form's model (#1074): After and Touches as typed, read into what the Plan actor takes, an item's
 * values shown back to edit, and which of the two an edit changes.
 */
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@agentic/core';
import { FORM_AFTER_MAX, FORM_PATH_MAX, FORM_TOUCHES_MAX, draftOf, linksChanged, newItemInput, readAfter, readItemLinks, readTouches } from '../../src/pages/projects/features/plan/shared/item-form';

const item = (over: Partial<PlanItem> = {}): PlanItem => ({ id: 9, title: 'x', state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });

describe('readAfter (#1074)', () => {
    const cases: readonly [string, readonly (number | string)[]][] = [
        ['', []],
        ['3', [3]],
        ['#3, #5', [3, 5]],
        ['#3 #5,7', [3, 5, 7]],
        ['signalx#14', ['signalx#14']],
        ['#3, signalx#14, #3, SignalX#14', [3, 'signalx#14']],
        ['  #2  ', [2]]
    ];
    for (const [text, values] of cases) it(`reads “${text}”`, () => expect(readAfter(text)).toEqual({ values }));

    for (const bad of ['abc', '#0', '#-1', '3.5', '#', 'a b#', 'x#y']) {
        it(`refuses “${bad}”`, () => expect(readAfter(bad).error).toMatch(/^After takes #n or project#n, not “/));
    }
});

describe('readTouches (#1074)', () => {
    const cases: readonly [string, readonly string[]][] = [
        ['', []],
        ['packages/a/', ['packages/a/']],
        ['packages/a/\n\n  apps/web/x.ts  \r\npackages/a/', ['packages/a/', 'apps/web/x.ts']],
        ['packages\\a\\b.ts', ['packages/a/b.ts']]
    ];
    for (const [text, paths] of cases) it(`reads ${JSON.stringify(text)}`, () => expect(readTouches(text)).toEqual({ paths }));

    for (const bad of ['/etc/passwd', 'C:/x', 'c:\\x', 'a/../b', '..']) {
        it(`refuses ${JSON.stringify(bad)}`, () => expect(readTouches(bad).error).toMatch(/^Paths are relative to the project/));
    }
});

describe('the Plan actor’s limits, as field errors (#1074)', () => {
    it('after: at most FORM_AFTER_MAX items', () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => `#${i + 1}`).join(', ');
        expect(readAfter(many(FORM_AFTER_MAX)).values).toHaveLength(FORM_AFTER_MAX);
        expect(readAfter(many(FORM_AFTER_MAX + 1)).error).toBe(`After holds at most ${FORM_AFTER_MAX} items.`);
    });
    it('touches: at most FORM_TOUCHES_MAX paths, each at most FORM_PATH_MAX characters', () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => `p${i}/`).join('\n');
        expect(readTouches(many(FORM_TOUCHES_MAX)).paths).toHaveLength(FORM_TOUCHES_MAX);
        expect(readTouches(many(FORM_TOUCHES_MAX + 1)).error).toBe(`Touches holds at most ${FORM_TOUCHES_MAX} paths.`);
        expect(readTouches('a'.repeat(FORM_PATH_MAX)).paths).toHaveLength(1);
        expect(readTouches('a'.repeat(FORM_PATH_MAX + 1)).error).toBe(`A path is at most ${FORM_PATH_MAX} characters.`);
    });
});

describe('readItemLinks (#1074)', () => {
    it('both right: the links', () => {
        expect(readItemLinks({ after: '#1', touches: 'a/' })).toEqual({ links: { after: [1], touches: ['a/'] } });
    });
    it('either wrong: no links, the field’s error', () => {
        const read = readItemLinks({ after: 'nope', touches: '/abs' });
        expect(read.links).toBeUndefined();
        expect(read.afterError).toBeDefined();
        expect(read.touchesError).toBeDefined();
        expect(readItemLinks({ after: '', touches: '/abs' })).toEqual({ touchesError: expect.any(String) });
    });
});

describe('draftOf and linksChanged (#1074)', () => {
    it('shows an item’s after (with other projects’ waits) and touches', () => {
        const it9 = { ...item({ after: [2, 4], touches: ['a/', 'b/c.ts'] }), afterRefs: [{ projectId: 'prj_x', n: 7 }] } as PlanItem;
        expect(draftOf(it9)).toEqual({ after: '#2, #4, prj_x#7', touches: 'a/\nb/c.ts' });
    });

    it('an unchanged draft changes nothing; the order of after does not matter, the order of touches does', () => {
        const it9 = item({ after: [2, 4], touches: ['a/', 'b/'] });
        expect(linksChanged(it9, readItemLinks(draftOf(it9)).links!)).toEqual({ after: false, touches: false });
        expect(linksChanged(it9, { after: [4, 2], touches: ['a/', 'b/'] })).toEqual({ after: false, touches: false });
        expect(linksChanged(it9, { after: [2], touches: ['a/', 'b/'] })).toEqual({ after: true, touches: false });
        expect(linksChanged(it9, { after: [2, 4], touches: [] })).toEqual({ after: false, touches: true });
        expect(linksChanged(it9, { after: [2, 4], touches: ['b/', 'a/'] })).toEqual({ after: false, touches: true });
    });
});

describe('newItemInput (#1074)', () => {
    it('names after and touches only when given', () => {
        expect(newItemInput('t', { after: [], touches: [] })).toEqual({ title: 't' });
        expect(newItemInput('t', { after: [1, 'p#2'], touches: ['a/'] })).toEqual({ title: 't', after: [1, 'p#2'], touches: ['a/'] });
    });
});
