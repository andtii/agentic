/** `SlotMarks` (#726): five 22 px marks, used or not, each named in words. */
import { PROJECT_FEATURE_SLOTS, SlotMarks } from '@agentic/ui';
import { mount } from '../helpers';

const marks = (host: ParentNode): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-ag-project="slot-marks"] > li')];

describe('SlotMarks', () => {
    it('draws five empty marks without a ui block', () => {
        const items = marks(mount(<SlotMarks />));
        expect(items.map((m) => m.getAttribute('data-slot'))).toEqual([...PROJECT_FEATURE_SLOTS]);
        for (const m of items) {
            expect(m.hasAttribute('data-used')).toBe(false);
            expect(m.getAttribute('aria-label')).toMatch(/: not used$/);
            expect(m.getAttribute('style')).toContain('color: var(--ag-line-strong)');
            expect(m.getAttribute('style')).toContain('inline-size: 22px');
        }
    });

    it('fills the slots the feature uses', () => {
        const host = mount(<SlotMarks ui={{ section: { label: 'Code', icon: 'code' }, overviewCard: { title: 'Code' }, workStages: ['Ready', 'Code'], chatRefPrefixes: ['pr:'], tools: ['git'] }} />);
        expect(host.querySelector('ul')!.getAttribute('aria-label')).toBe('Feature slots');
        expect(marks(host).map((m) => m.getAttribute('aria-label'))).toEqual([
            'Section: used', 'Overview card: used', 'Work stages: used', 'Chat context: used', 'Agent instructions and tools: used'
        ]);
        for (const m of marks(host)) expect(m.getAttribute('style')).toContain('color: var(--color-base-content)');
    });

    it('fills the last mark for instructions alone', () => {
        const items = marks(mount(<SlotMarks ui={{ chatRefPrefixes: ['item:'] }} instructions />));
        expect(items.filter((m) => m.hasAttribute('data-used')).map((m) => m.getAttribute('data-slot'))).toEqual(['chatRefPrefixes', 'tools']);
        expect(items[0]!.getAttribute('title')).toBe('Section: not used');
    });
});
