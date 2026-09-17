import { PACKAGE } from '../src/index';

describe('@agentic/a2a', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/a2a');
    });
});
