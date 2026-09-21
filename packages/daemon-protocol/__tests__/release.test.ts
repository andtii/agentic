/** Version helpers (#360): semver order with `main` builds below their release, the release asset key, and the named lifecycle reasons. */

import { WIRE_PROTOCOL_VERSION } from '@sigx/ai-agent/wire';
import { DAEMON_FEATURES, DRAINING, HARNESS_PHASES, SESSION_CLOSED_CODES, UPDATE_PHASES, compareVersions, drainingReply, isDrainingReply, isHttpsAsset, isVersion, platformKey, wireReply } from '../src/index';

const order = (versions: readonly string[]) => [...versions].sort(compareVersions);

describe('compareVersions', () => {
    it('orders a main build below its release and above the one before (0.2.0 > 0.2.0-main.abc1234 > 0.1.9)', () => {
        expect(compareVersions('0.2.0', '0.2.0-main.abc1234')).toBeGreaterThan(0);
        expect(compareVersions('0.2.0-main.abc1234', '0.1.9')).toBeGreaterThan(0);
        expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0);
        expect(order(['0.2.0', '0.1.9', '0.2.0-main.abc1234'])).toEqual(['0.1.9', '0.2.0-main.abc1234', '0.2.0']);
    });

    // #437: a main build is `x.y.z-main.<commit unix seconds>.<sha7>`; the time is a numeric identifier, so it decides.
    it('orders main builds of one release by commit time, never by sha, and all of them below the release', () => {
        const older = '0.2.0-main.1790000000.fffffff';
        const newer = '0.2.0-main.1790000060.0000abc';
        expect(compareVersions(newer, older)).toBeGreaterThan(0);
        expect(compareVersions(older, newer)).toBeLessThan(0);
        expect(compareVersions('0.2.0', newer)).toBeGreaterThan(0);
        expect(compareVersions(older, '0.1.9')).toBeGreaterThan(0);
        // A ten-digit time against an eleven-digit one: numerically, not as text.
        expect(compareVersions('0.2.0-main.10000000000.abc1234', '0.2.0-main.9999999999.abc1234')).toBeGreaterThan(0);
        expect(order(['0.2.0', newer, '0.2.0-main.0.abc1234', older, '0.1.9'])).toEqual(['0.1.9', '0.2.0-main.0.abc1234', older, newer, '0.2.0']);
        expect(isVersion(newer)).toBe(true);
        expect(isVersion('0.2.0-main.1790000000.g0123456')).toBe(true);
        expect(isVersion('0.2.0-main.1790000000.0123456')).toBe(false);
    });

    it('is semver: numeric parts numerically, equal versions 0, build metadata ignored', () => {
        expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
        expect(compareVersions('1.2.3+build.7', '1.2.3')).toBe(0);
        expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
        expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
        expect(compareVersions('99999999999999999999.0.0', '99999999999999999998.0.0')).toBeGreaterThan(0);
    });

    it('orders other prereleases by semver precedence', () => {
        // The example from semver §11.
        const precedence = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
        expect(order([...precedence].reverse())).toEqual(precedence);
        expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
        expect(compareVersions('1.0.0-rc.1', '0.9.9')).toBeGreaterThan(0);
    });

    it('orders malformed input below every valid version', () => {
        for (const bad of ['', 'latest', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3-01', '1.2.3.4', ' 1.2.3']) {
            expect(isVersion(bad), bad).toBe(false);
            expect(compareVersions(bad, '0.0.0-a'), bad).toBeLessThan(0);
            expect(compareVersions('0.0.0-a', bad), bad).toBeGreaterThan(0);
        }
        expect(compareVersions('latest', 'latest')).toBe(0);
        expect(order(['1.0.0', 'nope', '0.1.0'])).toEqual(['nope', '0.1.0', '1.0.0']);
        expect(isVersion('0.2.0-main.abc1234')).toBe(true);
    });
});

describe('platformKey', () => {
    it('is <platform>-<arch> in the names Node gives them', () => {
        expect(platformKey('win32', 'x64')).toBe('win32-x64');
        expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
        expect(platformKey('darwin', 'x64')).toBe('darwin-x64');
        expect(platformKey('linux', 'x64')).toBe('linux-x64');
        expect(platformKey('linux', 'arm64')).toBe('linux-arm64');
    });
});

describe('isHttpsAsset', () => {
    const asset = { url: 'https://releases.example.test/d.zip', sha256: 'f0'.repeat(32), bytes: 10, version: '1.0.0' };

    it('takes an https asset with a 64-hex digest', () => {
        expect(isHttpsAsset(asset)).toBe(true);
    });

    it('refuses anything a daemon must not fetch or cannot verify', () => {
        for (const bad of [null, 'https://x.test/d.zip', { ...asset, url: 'http://x.test/d.zip' }, { ...asset, url: 'nope' }, { ...asset, sha256: 'f0' }, { ...asset, sha256: 'g'.repeat(64) }, { ...asset, bytes: 0 }, { ...asset, bytes: '10' }, { ...asset, version: '' }])
            expect(isHttpsAsset(bad), JSON.stringify(bad)).toBe(false);
    });
});

describe('named lifecycle reasons', () => {
    it('lists every SessionClosedCode, feature and phase', () => {
        expect(SESSION_CLOSED_CODES).toEqual(['restart', 'update', 'harness-update', 'draining', 'harness-missing', 'resume-failed']);
        expect(DAEMON_FEATURES).toEqual(['update', 'harness']);
        expect(UPDATE_PHASES).toEqual(['downloading', 'verifying', 'staged', 'draining', 'restarting', 'failed']);
        expect(HARNESS_PHASES).toEqual(['downloading', 'verifying', 'staged', 'draining', 'applying', 'done', 'failed']);
    });

    it('a draining refusal is a valid wire error the platform parks like busy, and is told apart from busy', () => {
        const reply = drainingReply('cmd_1', 'update u_1 waits for 2 running turns');
        expect(DRAINING).toBe('draining');
        expect(reply).toEqual({ v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: 'cmd_1', code: 'busy', message: 'draining: update u_1 waits for 2 running turns' });
        expect(wireReply.safeParse(reply).success).toBe(true);
        expect(isDrainingReply(reply)).toBe(true);
        expect(isDrainingReply(drainingReply('cmd_2'))).toBe(true);
        expect(isDrainingReply({ v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: 'c', code: 'busy', message: 'a turn is running' })).toBe(false);
        expect(isDrainingReply({ v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: 'c', code: 'closed', message: 'draining: no' })).toBe(false);
        expect(isDrainingReply({ v: WIRE_PROTOCOL_VERSION, kind: 'ack', commandId: 'c' })).toBe(false);
    });
});
