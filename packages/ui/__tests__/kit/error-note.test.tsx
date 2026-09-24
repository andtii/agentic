/**
 * ErrorNote: an error line on zero's Alert — always `role="alert"`, the error
 * colour, an optional title, and the site's own `data-*` hook kept.
 */
import { describe, it, expect } from 'vitest';
import { ErrorNote } from '@agentic/ui';
import { mount, one } from '../helpers';

describe('ErrorNote', () => {
    it('renders role=alert on zero Alert in the error colour and keeps the passed data-* hook', () => {
        const root = mount(<ErrorNote data-save-error="" class="wide">The save failed.</ErrorNote>);
        const alert = root.querySelector<HTMLElement>('[data-save-error]')!;
        expect(alert).not.toBeNull();
        expect(alert.getAttribute('role')).toBe('alert');
        expect(alert.getAttribute('data-scope')).toBe('alert');
        expect(alert.getAttribute('data-part')).toBe('root');
        expect(alert.getAttribute('data-color')).toBe('error');
        expect(alert.getAttribute('data-size')).toBe('sm');
        expect(alert.getAttribute('class')).toBe('wide');
        expect(one(alert, 'alert', 'description')!.textContent).toBe('The save failed.');
        expect(one(alert, 'alert', 'title')).toBeNull();
    });

    it('shows an optional title before the description', () => {
        const root = mount(<ErrorNote title="Could not connect" data-connect-error="">Check the token.</ErrorNote>);
        const alert = root.querySelector<HTMLElement>('[data-connect-error]')!;
        const title = one(alert, 'alert', 'title')!;
        expect(title.textContent).toBe('Could not connect');
        expect(alert.hasAttribute('title')).toBe(false);
        expect(title.compareDocumentPosition(one(alert, 'alert', 'description')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
