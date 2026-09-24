/**
 * Identity and attribution: agents are squares in their hue, people are
 * circles; the environment line always names all three parts (EXE-06).
 */
import { AgentTile, EnvironmentLine, hueFor, monogramOf } from '@agentic/ui';
import { mount, one } from '../helpers';

describe('AgentTile', () => {
    it('is a square Avatar with the monogram as its fallback, in the agent hue at the requested size', () => {
        const root = mount(<AgentTile name="Forge" hue={2} size={44} />);
        const tile = one(root, 'avatar', 'root')!;
        expect(tile.getAttribute('data-shape')).toBe('square');
        expect(tile.getAttribute('data-hue')).toBe('2');
        // The design system's avatar patch turns these into --ag-tile / --ag-hue.
        expect(tile.getAttribute('data-tile')).toBe('44');
        expect(one(root, 'avatar', 'fallback')!.textContent).toBe('FO');
        // Decorative next to a written name; the name is the tooltip.
        expect(tile.getAttribute('aria-hidden')).toBe('true');
        expect(tile.getAttribute('title')).toBe('Forge');
        expect(tile.hasAttribute('role')).toBe(false);
        expect(tile.hasAttribute('aria-label')).toBe(false);
        expect(one(mount(<AgentTile name="Atlas" />), 'avatar', 'root')!.getAttribute('data-tile')).toBe('32');
    });

    it('draws a person as a circle without a hue, labelled when asked', () => {
        const root = mount(<AgentTile name="Andii" person hue={1} labelled />);
        const tile = one(root, 'avatar', 'root')!;
        expect(tile.getAttribute('data-shape')).toBe('circle');
        expect(tile.hasAttribute('data-hue')).toBe(false);
        // Labelled: an image named by the person, with no tooltip and not hidden.
        expect(tile.getAttribute('role')).toBe('img');
        expect(tile.getAttribute('aria-label')).toBe('Andii');
        expect(tile.hasAttribute('aria-hidden')).toBe(false);
        expect(tile.hasAttribute('title')).toBe(false);
    });

    it('derives two-letter monograms and wraps hues past four', () => {
        expect(monogramOf('Atlas')).toBe('AT');
        expect(monogramOf('personal assistant')).toBe('PA');
        expect(monogramOf('x')).toBe('X');
        expect([0, 1, 2, 3, 4, 5, 9].map(hueFor)).toEqual([1, 2, 3, 4, 1, 2, 2]);
    });
});

describe('EnvironmentLine', () => {
    it('carries fit="drop-machine" as data-fit so the phone can drop the machine segment last', () => {
        const root = mount(<EnvironmentLine machine="alien01" runtime="claude-code" account="work" fit="drop-machine" />);
        const line = root.querySelector('[data-scope="ag-env-line"][data-part="root"]')!;
        expect(line.getAttribute('data-fit')).toBe('drop-machine');
        // All three parts still render (EXE-06); the title keeps them in full.
        expect(line.querySelector('[data-part="machine"]')!.textContent).toBe('alien01');
        expect(line.getAttribute('title')).toBe('alien01 / claude-code / work');
        expect(mount(<EnvironmentLine machine="a" runtime="b" account="c" />).querySelector('[data-part="root"]')!.hasAttribute('data-fit')).toBe(false);
    });

    it('renders machine / runtime / account with dim separators and never one part alone', () => {
        const root = mount(<EnvironmentLine machine="alien01" runtime="claude-code" account="work" />);
        const line = one(root, 'ag-env-line', 'root')!;
        expect(line.getAttribute('data-tone')).toBe('muted');
        expect(line.getAttribute('title')).toBe('alien01 / claude-code / work');
        expect(one(root, 'ag-env-line', 'machine')!.textContent).toBe('alien01');
        expect(one(root, 'ag-env-line', 'runtime')!.textContent).toBe('claude-code');
        expect(one(root, 'ag-env-line', 'account')!.textContent).toBe('work');
        expect(root.querySelectorAll('[data-part="sep"]').length).toBe(2);
        expect(line.textContent).toBe('alien01/claude-code/work');
    });

    it('takes a tone', () => {
        const root = mount(<EnvironmentLine machine="platform" runtime="anthropic-api" account="byo-key" tone="dim" />);
        expect(one(root, 'ag-env-line', 'root')!.getAttribute('data-tone')).toBe('dim');
    });

    it('refuses a lone part in development (EXE-06)', () => {
        expect(() => mount(<EnvironmentLine machine="alien01" runtime="" account="work" />)).toThrow(/EXE-06/);
    });
});
