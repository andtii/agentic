import { describe, it, expect } from 'vitest';
import { filterMentions } from '../src/composer/mentions';

const people = [
    { id: 'alice', label: 'Alice' },
    { id: 'albert', label: 'Albert' },
    { id: 'bob', label: 'Bob Malice' }
];

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
