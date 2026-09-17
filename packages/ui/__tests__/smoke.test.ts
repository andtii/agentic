import { PACKAGE } from '../src/index';

describe('@agentic/ui', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/ui');
    });
});
