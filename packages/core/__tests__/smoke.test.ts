import { PACKAGE } from '../src/index';

describe('@agentic/core', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/core');
    });
});
