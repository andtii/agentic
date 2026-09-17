import { PACKAGE } from '../src/index';

describe('@agentic/runtimes', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/runtimes');
    });
});
