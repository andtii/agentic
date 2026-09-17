import { DAEMON_VERSION } from '../src/index';

describe('daemon', () => {
    it('has a version', () => {
        expect(DAEMON_VERSION).toBe('0.0.0');
    });
});
