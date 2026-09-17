import { PACKAGE } from '../src/index';

describe('@agentic/mcp', () => {
    it('exports its package name', () => {
        expect(PACKAGE).toBe('@agentic/mcp');
    });
});
