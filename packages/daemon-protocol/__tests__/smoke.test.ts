import { PACKAGE } from '../src/index';

describe('@agentic/daemon-protocol', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/daemon-protocol');
    });
});
