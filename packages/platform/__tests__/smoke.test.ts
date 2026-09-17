import { PACKAGE } from '../src/index';

describe('@agentic/platform', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/platform');
    });
});
