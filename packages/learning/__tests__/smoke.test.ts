import { PACKAGE } from '../src/index';

describe('@agentic/learning', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/learning');
    });
});
