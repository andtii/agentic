/** `codexCliQuota`: `account/rateLimits/read` (recorded from codex-cli 0.155.1) and streamed updates as snapshots (#320). */
import type { EnvironmentId, LocalEnvironment, PluginContext } from '@agentic/core';
import { CODEX_CLI_QUOTA_ID, codexCliPlugin } from '../../src/index';
import { codexCliQuota, quotaFromRateLimits, quotaFromRateLimitUpdate, type CodexConnect } from '../../src/codex-cli/index';
import type { GetAccountRateLimitsResponse } from '../../src/codex-cli/protocol';
import teamLimits from './fixtures/rate-limits-team.json';
import { FakeAppServer } from './fake-app-server';

const env: LocalEnvironment = { id: 'env_m1_codex' as EnvironmentId, name: 'Codex', runtime: 'codex-cli', profileDir: '/profiles/codex', cwdRoots: ['/work'], concurrency: 1 };
const AT = Date.UTC(2026, 8, 19, 12);
const logs: { level: string; message: string }[] = [];
const ctx: PluginContext = { now: () => AT, log: (level, message) => logs.push({ level, message }) };
const chatgpt = { type: 'chatgpt', email: 'dev@example.com', planType: 'team' } as const;

function connectTo(server: FakeAppServer): CodexConnect {
    return async () => server.connection();
}

describe('quotaFromRateLimits — the recorded answer', () => {
    it('maps primary to the session window and secondary to the week; 0..100 becomes 0..1, epoch seconds become ISO', () => {
        const s = quotaFromRateLimits(env, teamLimits as unknown as GetAccountRateLimitsResponse, chatgpt, AT);
        expect(s).toMatchObject({ sourceId: CODEX_CLI_QUOTA_ID, runtime: 'codex-cli', environmentId: env.id, plan: 'team', availability: 'reported', observedAt: AT, via: 'probe' });
        expect(s.windows).toEqual([
            { id: 'primary', label: 'Current session', period: 'session', utilization: 0, unit: 'percent', resetsAt: new Date(1789857245 * 1000).toISOString(), status: 'ok' },
            { id: 'secondary', label: 'Current week', period: 'week', utilization: 0.12, unit: 'percent', resetsAt: new Date(1789975011 * 1000).toISOString(), status: 'ok' }
        ]);
    });

    it('status follows utilization', () => {
        const limits = { ...teamLimits.rateLimits, primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } };
        const s = quotaFromRateLimits(env, { ordinaryUsageAllowed: false, rateLimits: limits, rateLimitsByLimitId: null } as unknown as GetAccountRateLimitsResponse, chatgpt, AT);
        expect(s.windows.map((w) => [w.id, w.status])).toEqual([
            ['primary', 'warning'],
            ['secondary', 'exhausted']
        ]);
        expect(s.windows[0]!.resetsAt).toBeUndefined();
    });

    it('a streamed update is a partial snapshot', () => {
        expect(quotaFromRateLimitUpdate(env, teamLimits.rateLimits as never, AT)).toMatchObject({ availability: 'partial', via: 'stream', plan: 'team', windows: [{ id: 'primary' }, { id: 'secondary' }] });
        expect(quotaFromRateLimitUpdate(env, { ...teamLimits.rateLimits, primary: null, secondary: null } as never, AT)).toBeNull();
    });
});

describe('codexCliQuota', () => {
    it('is the codex-cli source, and codexCliPlugin says it reports usage limits', () => {
        const q = codexCliQuota({ connect: connectTo(new FakeAppServer()) });
        expect(q).toMatchObject({ id: CODEX_CLI_QUOTA_ID, runtime: 'codex-cli' });
        expect(codexCliPlugin.capabilities).toContain('usage-limits');
    });

    it('probes a ChatGPT account without a thread or a turn, then closes the app-server', async () => {
        const server = new FakeAppServer();
        server.rateLimits = teamLimits;
        const s = await codexCliQuota({ connect: connectTo(server) }).probe!(env, ctx);
        expect(s).toMatchObject({ availability: 'reported', plan: 'team', windows: [{ id: 'primary' }, { id: 'secondary' }] });
        expect(server.requests.map((r) => r.method)).toEqual(['account/read', 'account/rateLimits/read']);
        expect(server.closedCount).toBe(1);
    });

    it('says why an API-key or signed-out profile reports nothing, without asking for limits', async () => {
        const apiKey = new FakeAppServer();
        apiKey.account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
        expect(await codexCliQuota({ connect: connectTo(apiKey) }).probe!(env, ctx)).toMatchObject({ availability: 'not-reported', reason: 'Signed in with an API key: Codex reports no plan limits for it' });
        expect(apiKey.requests.map((r) => r.method)).toEqual(['account/read']);
        const out = new FakeAppServer();
        out.account = { account: null, requiresOpenaiAuth: true };
        expect(await codexCliQuota({ connect: connectTo(out) }).probe!(env, ctx)).toMatchObject({ availability: 'not-reported', reason: 'Not signed in to ChatGPT' });
    });

    it('a failed probe is null and logged; another runtime is not its business', async () => {
        const server = new FakeAppServer();
        const q = codexCliQuota({ connect: connectTo(server) });
        expect(await q.probe!(env, ctx)).toBeNull();
        expect(logs.at(-1)).toMatchObject({ level: 'warn' });
        expect(await q.probe!({ ...env, runtime: 'claude-code' }, ctx)).toBeNull();
        const failing = codexCliQuota({ connect: async () => Promise.reject(new Error('spawn codex ENOENT')) });
        expect(await failing.probe!(env, ctx)).toBeNull();
    });

    it('fromSignal reads the ext the adapter re-emits, and nothing else', () => {
        const q = codexCliQuota({ connect: connectTo(new FakeAppServer()) });
        expect(q.fromSignal!({ ns: 'codex-cli', name: 'rate-limits', data: teamLimits.rateLimits }, env)).toMatchObject({ availability: 'partial', windows: [{ id: 'primary' }, { id: 'secondary' }] });
        expect(q.fromSignal!({ ns: 'claude-code', name: 'rate-limit', data: {} }, env)).toBeNull();
        expect(q.fromSignal!({ ns: 'codex-cli', name: 'rate-limits', data: teamLimits.rateLimits }, { ...env, runtime: 'claude-code' })).toBeNull();
    });
});
