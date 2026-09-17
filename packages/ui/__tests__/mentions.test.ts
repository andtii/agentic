import { describe, it, expect } from 'vitest';
import { filterMentions, insertMention, mentionAt, rowsFor } from '../src/composer/mentions';

const people = [
    { id: 'alice', label: 'Alice' },
    { id: 'albert', label: 'Albert' },
    { id: 'bob', label: 'Bob Malice' }
];

describe('mentionAt', () => {
    it('finds the token under the caret', () => {
        expect(mentionAt('hi @al', 6)).toEqual({ start: 3, end: 6, query: 'al' });
        expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    });

    it('is over once a space follows, and never inside a word', () => {
        expect(mentionAt('hi @al ', 7)).toBeUndefined();
        expect(mentionAt('mail@al', 7)).toBeUndefined();
        expect(mentionAt('no at here', 10)).toBeUndefined();
    });
});

describe('filterMentions', () => {
    it('prefers prefix matches, then substring matches, case-insensitively', () => {
        expect(filterMentions(people, 'al').map((m) => m.id)).toEqual(['alice', 'albert', 'bob']);
        expect(filterMentions(people, 'BOB').map((m) => m.id)).toEqual(['bob']);
        expect(filterMentions(people, '').map((m) => m.id)).toEqual(['alice', 'albert', 'bob']);
    });

    it('caps the list', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, label: `Person ${i}` }));
        expect(filterMentions(many, 'p')).toHaveLength(8);
    });
});

describe('insertMention', () => {
    it('replaces the token with the label and a trailing space, caret after it', () => {
        expect(insertMention('hi @al there', { start: 3, end: 6, query: 'al' }, people[0]!)).toEqual({ text: 'hi @Alice  there', caret: 10 });
    });
});

describe('rowsFor', () => {
    it('grows with the line count within bounds', () => {
        expect(rowsFor('', 1, 8)).toBe(1);
        expect(rowsFor('a\nb\nc', 1, 8)).toBe(3);
        expect(rowsFor('1\n2\n3\n4\n5\n6\n7\n8\n9\n10', 1, 8)).toBe(8);
        expect(rowsFor('x', 2, 8)).toBe(2);
    });
});
