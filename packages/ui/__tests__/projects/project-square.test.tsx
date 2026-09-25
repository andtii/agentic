/** `ProjectSquare` (#726): the project's colour (stored or picked from the id), the initial, 22 / 44 px. */
import { PROJECT_COLORS } from '@agentic/core';
import { ProjectSquare } from '@agentic/ui';
import { projectColorFor, projectInitial } from '../../src/projects/ProjectSquare';
import { mount } from '../helpers';

const square = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-ag-project="square"]')!;

describe('ProjectSquare', () => {
    it.each(PROJECT_COLORS.map((color, i) => [color, i + 1] as const))('draws %s in agent hue %i', (color, slot) => {
        const el = square(mount(<ProjectSquare name="agentic" color={color} />));
        expect(el.getAttribute('data-color')).toBe(color);
        expect(el.getAttribute('style')).toContain(`var(--ag-agent-${slot})`);
        expect(el.textContent).toBe('A');
        expect(el.getAttribute('aria-hidden')).toBe('true');
    });

    it('is 22 px by default and 44 px with a larger radius in the header', () => {
        const small = square(mount(<ProjectSquare name="web" />)).getAttribute('style')!;
        expect(small).toContain('inline-size: 22px');
        expect(small).toContain('border-radius: 6px');
        const large = square(mount(<ProjectSquare name="web" size={44} />)).getAttribute('style')!;
        expect(large).toContain('inline-size: 44px');
        expect(large).toContain('block-size: 44px');
        expect(large).toContain('border-radius: 10px');
    });

    it('picks a stable colour from the id, else the name, when none is stored', () => {
        const byId = square(mount(<ProjectSquare name="x" id="p_123" />)).getAttribute('data-color');
        expect(byId).toBe(projectColorFor('p_123'));
        expect(square(mount(<ProjectSquare name="other" id="p_123" />)).getAttribute('data-color')).toBe(byId);
        expect(square(mount(<ProjectSquare name="docs" />)).getAttribute('data-color')).toBe(projectColorFor('docs'));
        expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(projectColorFor)).size).toBeGreaterThan(1);
    });

    it('takes the first letter or digit as the initial', () => {
        expect(projectInitial('agentic')).toBe('A');
        expect(projectInitial('  _42 things')).toBe('4');
        expect(projectInitial('ölprojekt')).toBe('Ö');
        expect(projectInitial('--')).toBe('?');
    });
});
