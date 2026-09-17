// @vitest-environment node
/**
 * Isolation conformance for the Claude Code driver (EXE-04/05/07, AC-02):
 * three accounts on one machine, one `CLAUDE_CONFIG_DIR` each. Every session's
 * child environment is the same as every other's except for its own config
 * dir; starting a session in one profile changes nothing about another; two
 * profiles on one config dir are refused by `doctor()` with a named code, and
 * the per-environment verdict the daemon ships (`environmentVerdict`) says so
 * for exactly those two.
 *
 * Offline: the SDK `query` is scripted and the CLI "spawn" only records its
 * options — the very options a real `spawnClaudeCodeProcess` would receive.
 * `docs/multi-account.md` has the manual checklist for the real CLI.
 */
import type { Options, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { allowAll, type AgentTurn } from '@sigx/ai-agent';
import { environmentVerdict, type EnvironmentId, type LocalEnvironment, type OpenSpec, type SessionId } from '@agentic/core';
import { claudeCodeDriver, CLAUDE_CODE_DOCTOR_CODES, type ClaudeCodeDriver } from '../../src/claude-code/index';
import { fakeListen, fakeQuery, messageStart, messageStop, RESULT, textBlocks, type TurnScript } from './fake-query';

const profiles = {
    work: { id: 'environment_work' as EnvironmentId, dir: 'C:\\Users\\me\\.claude-work', root: 'C:\\src\\work' },
    personal: { id: 'environment_personal' as EnvironmentId, dir: 'C:\\Users\\me\\.claude-personal', root: 'C:\\src\\personal' },
    client: { id: 'environment_client' as EnvironmentId, dir: 'D:\\clients\\acme\\.claude', root: 'D:\\clients\\acme\\repo' }
} as const;
type Profile = keyof typeof profiles;

const env = (p: Profile, over: Partial<LocalEnvironment> = {}): LocalEnvironment => ({
    id: profiles[p].id,
    name: p,
    runtime: 'claude-code',
    profileDir: profiles[p].dir,
    cwdRoots: [profiles[p].root],
    concurrency: 1,
    accountLabel: `${p} account`,
    ...over
});
const spec = (p: Profile): OpenSpec => ({ agentId: 'agent_ada', cwd: `${profiles[p].root}\\app`, system: 'You are Ada.', tools: [] });
const ctx = (n: number) => ({ sessionId: `session_${n}` as SessionId, callTool: async () => ({ ok: true }), policy: allowAll });

/** The daemon's own environment: signed in as one of the profiles and carrying an API key — none of which may reach a child. */
const daemonEnv = {
    PATH: 'C:\\Windows\\system32',
    USERPROFILE: 'C:\\Users\\me',
    CLAUDE_CONFIG_DIR: profiles.personal.dir,
    ANTHROPIC_API_KEY: 'sk-ant-daemon-parent',
    ANTHROPIC_BASE_URL: 'https://gateway.invalid',
    anthropic_auth_token: 'lower-case-too'
};

/** A CLI "spawn" that records the options the SDK hands it, and a script that triggers it the way the SDK does. */
function spawning(): { spawned: { session: number; env: Record<string, string | undefined> }[]; script: TurnScript; spawn: (o: SpawnOptions) => SpawnedProcess } {
    const spawned: { session: number; env: Record<string, string | undefined> }[] = [];
    let turn = 0;
    const script: TurnScript = (_u, _t, c) => {
        const o = c.options as Options;
        turn++;
        o.spawnClaudeCodeProcess?.({ command: 'claude', args: [], cwd: o.cwd, env: o.env ?? {}, signal: new AbortController().signal } as SpawnOptions);
        return [messageStart(), ...textBlocks('ok'), ...messageStop(), RESULT()];
    };
    const spawn = (o: SpawnOptions) => {
        spawned.push({ session: turn, env: { ...(o.env as Record<string, string | undefined>) } });
        return { killed: false, exitCode: null, kill: () => true, on: () => undefined, once: () => undefined, off: () => undefined } as unknown as SpawnedProcess;
    };
    return { spawned, script, spawn };
}

async function drain(turn: AgentTurn): Promise<void> {
    for await (const _ of turn) {
        // consume
    }
    await turn.result;
}

/** The child env without the one variable that is allowed to differ. */
const withoutConfigDir = (e: Record<string, string | undefined>) => {
    const { CLAUDE_CONFIG_DIR: _own, ...rest } = e;
    return rest;
};

describe('Claude Code isolation conformance (EXE-04/05/07, AC-02)', () => {
    let driver: ClaudeCodeDriver;
    let spawned: ReturnType<typeof spawning>['spawned'];
    beforeEach(() => {
        const s = spawning();
        spawned = s.spawned;
        driver = claudeCodeDriver({ query: fakeQuery(s.script).query, listen: fakeListen, spawn: s.spawn, parentEnv: daemonEnv, home: 'C:\\Users\\me' });
    });
    afterEach(() => driver.dispose());

    it('three profiles are three agents with three config dirs, and none is the daemon\'s own', () => {
        const agents = (['work', 'personal', 'client'] as Profile[]).map((p) => driver.agentFor(env(p)));
        expect(new Set(agents).size).toBe(3);
        expect(agents.map((a) => a.id)).toEqual(['claude-code:environment_work', 'claude-code:environment_personal', 'claude-code:environment_client']);
        expect((['work', 'personal', 'client'] as Profile[]).map((p) => driver.configDirOf(env(p)))).toEqual([profiles.work.dir, profiles.personal.dir, profiles.client.dir]);
    });

    it('every session runs with its own CLAUDE_CONFIG_DIR and an otherwise identical environment; no account variable of the daemon leaks', async () => {
        const order: Profile[] = ['work', 'personal', 'client', 'work', 'client', 'personal'];
        let n = 0;
        for (const p of order) {
            const { session } = await driver.open(env(p), spec(p), ctx(++n));
            await drain(session.prompt(`hello from ${p}`));
            await session.close();
        }
        expect(spawned).toHaveLength(order.length);

        for (const [i, p] of order.entries()) {
            const child = spawned[i]!.env;
            expect(child.CLAUDE_CONFIG_DIR).toBe(profiles[p].dir);
            // Nothing that could pick another account: neither the daemon's variables nor another profile's dir.
            for (const key of Object.keys(child)) expect(key).not.toMatch(/^anthropic_/i);
            for (const other of Object.keys(profiles) as Profile[]) if (other !== p) expect(Object.values(child)).not.toContain(profiles[other].dir);
        }
        // The children differ in the config dir and in nothing else (AC-02: "each session's spawn env differs only in its own profile").
        const rest = spawned.map((s) => withoutConfigDir(s.env));
        for (const r of rest.slice(1)) expect(r).toEqual(rest[0]);
    });

    it('starting a session in one profile changes nothing about another: same agent, same config dir, same child env before and after', async () => {
        const before = driver.agentFor(env('work'));
        const first = await driver.open(env('work'), spec('work'), ctx(1));
        await drain(first.session.prompt('one'));
        await first.session.close();

        const other = await driver.open(env('personal'), spec('personal'), ctx(2));
        await drain(other.session.prompt('two'));
        await other.session.close();

        const again = await driver.open(env('work'), spec('work'), ctx(3));
        await drain(again.session.prompt('three'));
        await again.session.close();

        expect(driver.agentFor(env('work'))).toBe(before);
        expect(driver.configDirOf(env('work'))).toBe(profiles.work.dir);
        expect(spawned.map((s) => s.env.CLAUDE_CONFIG_DIR)).toEqual([profiles.work.dir, profiles.personal.dir, profiles.work.dir]);
        expect(spawned[2]!.env).toEqual(spawned[0]!.env);
    });

    it('refuses a cwd from another profile\'s roots — an environment cannot be pointed at another account\'s work', async () => {
        await expect(driver.open(env('work'), spec('client'), ctx(1))).rejects.toThrow(/outside the cwdRoots/);
        expect(spawned).toHaveLength(0);
    });

    describe('doctor() over the three profiles', () => {
        const files: Record<string, string> = {
            'C:/Users/me/.claude-work/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
            'C:/Users/me/.claude-work/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } }),
            'C:/Users/me/.claude-personal/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
            'C:/Users/me/.claude-personal/.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'me@home.example' } }),
            'D:/clients/acme/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 1 } })
        };
        const checked = () =>
            claudeCodeDriver({
                query: fakeQuery(() => [messageStart(), ...textBlocks('ok'), ...messageStop(), RESULT()]).query,
                listen: fakeListen,
                parentEnv: daemonEnv,
                home: 'C:\\Users\\me',
                auth: { platform: 'win32', now: () => 10, readText: async (p) => files[p.replace(/\\/g, '/')] }
            });

        it('passes three distinct config dirs and names each account', async () => {
            const d = checked();
            const report = await d.doctor([env('work'), env('personal'), env('client')]);
            expect(report.ok).toBe(true);
            expect(report.findings.map((f) => [f.code, f.environmentIds?.[0]])).toEqual([
                [CLAUDE_CODE_DOCTOR_CODES.authOk, profiles.work.id],
                [CLAUDE_CODE_DOCTOR_CODES.authOk, profiles.personal.id],
                [CLAUDE_CODE_DOCTOR_CODES.authExpired, profiles.client.id]
            ]);
            expect(report.findings[0]!.message).toContain('me@work.example');
            expect(report.findings[1]!.message).toContain('me@home.example');
            for (const p of ['work', 'personal', 'client'] as Profile[]) expect(environmentVerdict(report, profiles[p].id, 1).ok).toBe(true);
            await d.dispose();
        });

        it('refuses two profiles on one config dir with a named code, and the verdict fails exactly those two', async () => {
            const d = checked();
            const report = await d.doctor([env('work'), env('personal', { profileDir: 'c:/users/ME/.claude-work/' }), env('client')]);
            expect(report.ok).toBe(false);
            const errors = report.findings.filter((f) => f.level === 'error');
            expect(errors).toEqual([expect.objectContaining({ code: CLAUDE_CODE_DOCTOR_CODES.sharedConfigDir, environmentIds: [profiles.work.id, profiles.personal.id] })]);
            expect(CLAUDE_CODE_DOCTOR_CODES.sharedConfigDir).toBe('shared-config-dir');
            expect(environmentVerdict(report, profiles.work.id, 1)).toMatchObject({ ok: false, findings: [{ code: 'shared-config-dir' }, { code: 'auth-ok' }] });
            expect(environmentVerdict(report, profiles.personal.id, 1).ok).toBe(false);
            expect(environmentVerdict(report, profiles.client.id, 1)).toMatchObject({ ok: true, findings: [{ code: 'auth-expired' }] });
            await d.dispose();
        });

        it('warns, not errors, about a single profile on the default config dir — and errors once two are', async () => {
            const d = checked();
            const one = await d.doctor([env('work', { profileDir: undefined }), env('client')]);
            expect(one.ok).toBe(true);
            expect(one.findings.map((f) => f.code)).toContain(CLAUDE_CODE_DOCTOR_CODES.defaultConfigDir);
            const two = await d.doctor([env('work', { profileDir: undefined }), env('personal', { profileDir: undefined })]);
            expect(two.ok).toBe(false);
            expect(two.findings.find((f) => f.level === 'error')).toMatchObject({ code: 'shared-config-dir', environmentIds: [profiles.work.id, profiles.personal.id] });
            await d.dispose();
        });
    });
});
