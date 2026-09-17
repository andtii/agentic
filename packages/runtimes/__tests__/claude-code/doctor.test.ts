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
        expect(report.findings.find((f) => f.level === 'error')?.message).toContain('C:/Users/me/.claude');
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
