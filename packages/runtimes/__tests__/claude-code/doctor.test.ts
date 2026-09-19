/** `claudeCodeDoctor` and the driver's `doctor`: one config dir per account (EXE-07). */
import type { EnvironmentId, EnvironmentInspection, LocalEnvironment } from '@agentic/core';
import { claudeCodeDoctor, claudeCodeDriver, configDirKey } from '../../src/claude-code/index';

const env = (id: string, profileDir?: string, runtime = 'claude-code'): LocalEnvironment => ({
    id: `environment_${id}` as EnvironmentId,
    name: id,
    runtime,
    ...(profileDir === undefined ? {} : { profileDir }),
    cwdRoots: ['C:\\src'],
    concurrency: 1
});
const ok: EnvironmentInspection = { authStatus: 'ok', isolation: 'config-dir', capabilities: {} as never };

describe('configDirKey', () => {
    it('treats one Windows directory spelled differently as one key', () => {
        expect(configDirKey('C:\\Profiles\\Work\\')).toBe(configDirKey('c:/profiles/work'));
        expect(configDirKey('C:\\profiles\\a\\..\\work')).toBe(configDirKey('C:\\profiles\\work'));
        expect(configDirKey('C:\\profiles\\work')).not.toBe(configDirKey('C:\\profiles\\work2'));
    });
    it('keeps POSIX paths case-sensitive', () => {
        expect(configDirKey('/home/a/.claude')).not.toBe(configDirKey('/home/A/.claude'));
        expect(configDirKey('/home/a/.claude/')).toBe(configDirKey('/home/a/./.claude'));
    });
});

describe('claudeCodeDoctor', () => {
    it('fails loudly when two profiles share a config dir', () => {
        const report = claudeCodeDoctor([
            { env: env('work', 'C:\\profiles\\shared'), configDir: 'C:\\profiles\\shared', inspection: ok },
            { env: env('personal', 'c:/Profiles/Shared/'), configDir: 'c:/Profiles/Shared/', inspection: ok },
            { env: env('other', 'C:\\profiles\\other'), configDir: 'C:\\profiles\\other', inspection: ok }
        ]);
        expect(report.ok).toBe(false);
        const errors = report.findings.filter((f) => f.level === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ code: 'shared-config-dir', environmentIds: ['environment_work', 'environment_personal'] });
        expect(errors[0]!.message).toContain('"work", "personal"');
    });

    it('passes separate profiles and reports auth per profile', () => {
        const report = claudeCodeDoctor([
            { env: env('work', 'C:\\profiles\\work'), configDir: 'C:\\profiles\\work', inspection: { ...ok, identity: 'me@work.example' } },
            { env: env('personal', 'C:\\profiles\\personal'), configDir: 'C:\\profiles\\personal', inspection: { ...ok, authStatus: 'missing' } },
            { env: env('old', 'C:\\profiles\\old'), configDir: 'C:\\profiles\\old', inspection: { ...ok, authStatus: 'expired' } }
        ]);
        expect(report.ok).toBe(true);
        expect(report.findings.map((f) => [f.code, f.environmentIds?.[0]])).toEqual([
            ['auth-ok', 'environment_work'],
            ['auth-missing', 'environment_personal'],
            ['auth-expired', 'environment_old']
        ]);
        expect(report.findings[0]!.message).toContain('me@work.example');
    });

    it('warns about an environment on the default config dir', () => {
        const report = claudeCodeDoctor([{ env: env('bare'), configDir: 'C:/Users/me/.claude', inspection: { ...ok, isolation: 'none' } }]);
        expect(report.ok).toBe(true);
        expect(report.findings.map((f) => f.code)).toContain('default-config-dir');
    });
});

/**
 * The report IS what the platform receives (the verdict on each `EnvironmentDescriptor`), and a
 * profile path never leaves the machine (decisions 2026-09-19 (c), #274): no finding names one,
 * however it is spelled.
 */
describe('the reported verdict carries no local profile path (#274)', () => {
    const spellings = (path: string): string[] => {
        const slash = path.replace(/\\/g, '/');
        return [path, slash, path.replace(/\//g, '\\'), slash.toLowerCase(), slash.replace(/\/+$/, '')];
    };
    const expectNoPath = (report: unknown, paths: readonly string[], fragments: readonly string[]) => {
        const text = JSON.stringify(report);
        const lower = text.toLowerCase();
        for (const p of paths) for (const s of spellings(p)) expect(lower).not.toContain(JSON.stringify(s).slice(1, -1).toLowerCase());
        for (const f of fragments) expect(lower).not.toContain(f.toLowerCase());
    };
    // An 8.3 short spelling (what Windows hands back for `C:\Users\runneradmin`) and a long one.
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Roaming\\agentic\\profiles\\p7x1';
    const long = 'D:/Accounts/andy/claude-profiles/q9z2/';

    it('shared, signed out, expired, unknown and ok: messages name environments, never their profile dirs', () => {
        const report = claudeCodeDoctor([
            { env: { ...env('a', short), name: 'Work account' }, configDir: short, inspection: { ...ok, authStatus: 'missing' } },
            { env: { ...env('b', short.toLowerCase()), name: 'Work again' }, configDir: short.toLowerCase(), inspection: { ...ok, authStatus: 'expired' } },
            { env: { ...env('c', long), name: 'Personal' }, configDir: long, inspection: { ...ok, authStatus: 'unknown' } },
            { env: { ...env('d', 'E:\\keep\\r4t5'), name: 'Side' }, configDir: 'E:\\keep\\r4t5', inspection: { ...ok, identity: 'me@side.example' } }
        ]);
        expect(report.findings.map((f) => f.code)).toEqual(['shared-config-dir', 'auth-missing', 'auth-expired', 'auth-unknown', 'auth-ok']);
        expectNoPath(report, [short, long, 'E:\\keep\\r4t5'], ['RUNNER~1', 'p7x1', 'q9z2', 'r4t5', 'AppData', 'claude-profiles', 'CLAUDE_CONFIG_DIR']);
        // What the user needs is still there: who, which environment, and the command that fixes it.
        expect(report.findings[0]!.message).toContain('"Work account", "Work again"');
        expect(report.findings[1]!.message).toContain('agentic-daemon env login environment_a');
        expect(report.findings[4]!.message).toContain('me@side.example');
    });

    it('the default config dir is local too: its warning and a shared default name no path', async () => {
        const driver = claudeCodeDriver({ home: 'C:/Users/q8w3', parentEnv: {}, auth: { platform: 'win32', now: () => 10, readText: async () => undefined } });
        const report = await driver.doctor([env('a'), env('b')]);
        expect(report.findings.map((f) => f.code)).toEqual(['shared-config-dir', 'default-config-dir', 'auth-missing', 'default-config-dir', 'auth-missing']);
        expectNoPath(report, ['C:/Users/q8w3/.claude'], ['q8w3', '.claude']);
    });

    it('a profile that cannot be read is reported for that environment alone, without the path the error named', async () => {
        const denied = Object.assign(new Error(`EACCES: permission denied, open '${short}\\.credentials.json'`), { code: 'EACCES' });
        const driver = claudeCodeDriver({
            home: 'C:/Users/me',
            parentEnv: {},
            auth: { platform: 'win32', now: () => 10, readText: async (p) => (p.includes('p7x1') ? Promise.reject(denied) : undefined) }
        });
        const report = await driver.doctor([env('locked', short), env('fine', 'C:\\profiles\\fine')]);
        expect(report.findings.map((f) => [f.code, f.environmentIds])).toEqual([
            ['profile-unreadable', ['environment_locked']],
            ['auth-missing', ['environment_fine']]
        ]);
        expect(report.findings[0]!.message).toContain('EACCES');
        expectNoPath(report, [short], ['RUNNER~1', 'p7x1', 'permission denied, open']);
    });
});

describe('claudeCodeDriver.doctor', () => {
    const files: Record<string, string> = {
        'C:/profiles/work/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } }),
        'C:/profiles/work/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } })
    };
    const driver = claudeCodeDriver({
        home: 'C:/Users/me',
        parentEnv: {},
        auth: { platform: 'win32', now: () => 10, readText: async (p) => files[p.replace(/\\/g, '/')] }
    });

    it('fails for two profiles on one config dir, whichever way the path is written', async () => {
        const report = await driver.doctor([env('work', 'C:\\profiles\\work'), env('work-again', 'c:/PROFILES/work/')]);
        expect(report.ok).toBe(false);
        expect(report.findings.find((f) => f.level === 'error')?.code).toBe('shared-config-dir');
    });

    it('fails for two environments that both fall back to the default config dir', async () => {
        const report = await driver.doctor([env('a'), env('b')]);
        expect(report.ok).toBe(false);
        expect(report.findings.find((f) => f.level === 'error')?.message).toContain('the default Claude Code config dir');
    });

    it('checks only its own runtime and reports each profile once', async () => {
        const report = await driver.doctor([env('work', 'C:\\profiles\\work'), env('api', undefined, 'anthropic-api')]);
        expect(report.ok).toBe(true);
        expect(report.findings).toEqual([expect.objectContaining({ code: 'auth-ok', environmentIds: ['environment_work'] })]);
    });

    it('inspect reports isolation, auth and identity for the platform descriptor', async () => {
        const inspection = await driver.inspect(env('work', 'C:\\profiles\\work'));
        expect(inspection).toMatchObject({ authStatus: 'ok', identity: 'me@work.example', isolation: 'config-dir', capabilities: { runtime: 'claude-code' } });
        expect((await driver.inspect(env('bare'))).isolation).toBe('none');
    });
});
