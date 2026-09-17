import { PACKAGE } from '../src/index';

describe('@agentic/memory', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/memory');
    });
});
