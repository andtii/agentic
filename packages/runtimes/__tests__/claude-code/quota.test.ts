import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { EnvironmentId, LocalEnvironment, PluginContext } from '@agentic/core';
import { ANTHROPIC_API_QUOTA_REASON, CLAUDE_CODE_QUOTA_ID, QUOTA_PLUGINS, anthropicApiQuota } from '../../src/index';
import { claudeCodeQuota, quotaFromRateLimit, quotaFromUsage, type QuotaQueryFn } from '../../src/claude-code/index';
import usageMax from './fixtures/usage-max.json';
import usageSignedOut from './fixtures/usage-signed-out.json';

const env: LocalEnvironment = { id: 'env_m1_work' as EnvironmentId, name: 'Work', runtime: 'claude-code', profileDir: '/home/me/.claude-work', cwdRoots: ['/work'], concurrency: 2 };
const AT = Date.UTC(2026, 8, 19, 12);
const logs: { level: string; message: string; data?: Record<string, unknown> }[] = [];
const ctx: PluginContext = { now: () => AT, log: (level, message, data) => logs.push({ level, message, ...(data ? { data } : {}) }) };

/** The ext the adapter makes of a `rate_limit_event` (`@sigx/ai-agent-claude-code`: `ext claude-code/rate-limit`, data = the event without uuid / session_id). */
const rateLimitExt = (info: SDKRateLimitInfo) => ({ ns: 'claude-code', name: 'rate-limit', data: { type: 'rate_limit_event', rate_limit_info: info } });

describe('quotaFromUsage — the /usage answer (recorded)', () => {
    it('maps a Max account: session, week, the per-model week; 0..100 becomes 0..1; disabled extra usage is left out', () => {
        const s = quotaFromUsage(env, usageMax as unknown as SDKControlGetUsageResponse, undefined, AT);
        expect(s).toMatchObject({ sourceId: CLAUDE_CODE_QUOTA_ID, runtime: 'claude-code', environmentId: env.id, plan: 'max', availability: 'reported', observedAt: AT, via: 'probe' });
        expect(s.windows).toEqual([
            { id: 'five_hour', label: 'Current session', period: 'session', utilization: 0.04, unit: 'percent', resetsAt: '2026-09-19T16:10:00.224Z', status: 'ok' },
            { id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.04, unit: 'percent', resetsAt: '2026-09-25T10:00:00.224Z', status: 'ok' },
            { id: 'seven_day:fable', label: 'Current week (Fable)', period: 'week', scope: { model: 'Fable' }, utilization: 0, unit: 'percent', resetsAt: '2026-09-25T10:00:00.000Z', status: 'ok' }
        ]);
    });

    it('says why a signed-out profile reports nothing', () => {
        const s = quotaFromUsage(env, usageSignedOut as unknown as SDKControlGetUsageResponse, { tokenSource: 'none', apiProvider: 'firstParty' }, AT);
        expect(s).toMatchObject({ availability: 'not-reported', reason: 'Not signed in to a Claude subscription', windows: [] });
        expect(s.plan).toBeUndefined();
    });

    it('names an API-key login and a third-party provider as the reason', () => {
        const none = usageSignedOut as unknown as SDKControlGetUsageResponse;
        expect(quotaFromUsage(env, none, { apiKeySource: 'ANTHROPIC_API_KEY' } as never, AT).reason).toMatch(/API key/);
        expect(quotaFromUsage(env, none, { apiProvider: 'bedrock' }, AT).reason).toMatch(/bedrock/);
    });

    it('status follows utilization; the legacy per-model weeks, model_scoped and enabled extra usage are windows', () => {
        const usage = {
            ...usageMax,
            rate_limits: {
                five_hour: { utilization: 100, resets_at: '2026-09-19T16:00:00Z' },
                seven_day: { utilization: 81, resets_at: null },
                seven_day_opus: { utilization: 50, resets_at: null },
                model_scoped: [
                    { display_name: 'Opus', utilization: 60, resets_at: null },
                    { display_name: 'Sonnet', utilization: null, resets_at: null }
                ],
                extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24 }
            }
        } as unknown as SDKControlGetUsageResponse;
        const s = quotaFromUsage(env, usage, undefined, AT);
        expect(s.windows.map((w) => [w.id, w.utilization, w.status, w.unit])).toEqual([
            ['five_hour', 1, 'exhausted', 'percent'],
            ['seven_day', 0.81, 'warning', 'percent'],
            // The legacy field wins; model_scoped does not repeat it.
            ['seven_day:opus', 0.5, 'ok', 'percent'],
            ['seven_day:sonnet', null, 'unknown', 'percent'],
            ['extra_usage', 0.24, 'ok', 'usd']
        ]);
        expect(s.windows[1]!.resetsAt).toBeUndefined();
    });
});

describe('fromSignal — the streamed rate_limit_event', () => {
    const source = claudeCodeQuota();

    it('maps one window: 0..1 utilization, epoch-second resetsAt, the event status', () => {
        const s = source.fromSignal!(rateLimitExt({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.76, resetsAt: 1790589600 }), env)!;
        expect(s).toMatchObject({ sourceId: CLAUDE_CODE_QUOTA_ID, environmentId: env.id, availability: 'partial', via: 'stream' });
        expect(s.windows).toEqual([{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', resetsAt: new Date(1790589600 * 1000).toISOString(), status: 'warning' }]);
    });

    it('a rejection is exhausted — as an ext, and as the adapter`s error rate_limited event', () => {
        const info: SDKRateLimitInfo = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790589600 };
        expect(source.fromSignal!(rateLimitExt(info), env)!.windows[0]).toMatchObject({ id: 'five_hour', utilization: null, status: 'exhausted' });
        expect(source.fromSignal!({ ns: 'error', name: 'rate_limited', data: info }, env)!.windows[0]).toMatchObject({ id: 'five_hour', status: 'exhausted' });
    });

    it('allowed below the warning line is ok; per-model and overage windows line up with the probe ids', () => {
        expect(quotaFromRateLimit(env, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.19 }, AT)!.windows[0]!.status).toBe('ok');
        expect(quotaFromRateLimit(env, { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.3 }, AT)!.windows[0]!.id).toBe('seven_day:opus');
        expect(quotaFromRateLimit(env, { status: 'allowed', rateLimitType: 'overage', utilization: 0.1 }, AT)!.windows[0]).toMatchObject({ id: 'extra_usage', unit: 'usd' });
    });

    it('ignores what carries no known window: other exts, a rate_limited error without info, no rateLimitType, another runtime', () => {
        expect(source.fromSignal!({ ns: 'claude-code', name: 'auth-status', data: {} }, env)).toBeNull();
        expect(source.fromSignal!({ ns: 'error', name: 'rate_limited', data: undefined }, env)).toBeNull();
        expect(source.fromSignal!(rateLimitExt({ status: 'allowed' }), env)).toBeNull();
        expect(source.fromSignal!(rateLimitExt({ status: 'allowed', rateLimitType: 'seven_day_overage_included' }), env)).toBeNull();
        expect(source.fromSignal!(rateLimitExt({ status: 'allowed', rateLimitType: 'five_hour' }), { ...env, runtime: 'anthropic-api' })).toBeNull();
    });
});

describe('probe', () => {
    type Call = { options: Record<string, unknown> | undefined; closed: boolean; yielded: boolean };

    /** A fake `query`: records its options, answers the two control calls, never reads the prompt beyond the first pull. */
    function fakeQuery(answer: { usage?: () => Promise<unknown>; account?: () => Promise<unknown> } = {}): { query: QuotaQueryFn; calls: Call[] } {
        const calls: Call[] = [];
        const query: QuotaQueryFn = ({ prompt, options }) => {
            const call: Call = { options: options as Record<string, unknown> | undefined, closed: false, yielded: false };
            calls.push(call);
            // The prompt must never yield: a first pull stays pending until close releases it.
            void prompt[Symbol.asyncIterator]()
                .next()
                .then((r) => (call.yielded = !r.done));
            return {
                usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (() => (answer.usage ?? (() => Promise.resolve(usageMax)))()) as never,
                accountInfo: (() => (answer.account ?? (() => Promise.resolve({ subscriptionType: 'Claude Max' })))()) as never,
                close: () => {
                    call.closed = true;
                }
            };
        };
        return { query, calls };
    }

    beforeEach(() => {
        logs.length = 0;
    });

    it('reads /usage on an unprompted query under the environment`s own account, then closes it', async () => {
        const { query, calls } = fakeQuery();
        const parentEnv = { PATH: '/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'sk-parent', CLAUDE_CONFIG_DIR: '/home/me/.claude-other' };
        const s = await claudeCodeQuota({ query, parentEnv }).probe!(env, ctx);
        expect(s).toMatchObject({ availability: 'reported', plan: 'max', observedAt: AT, via: 'probe' });
        expect(s!.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day:fable']);
        expect(calls).toHaveLength(1);
        const childEnv = calls[0]!.options!.env as Record<string, string | undefined>;
        expect(childEnv.CLAUDE_CONFIG_DIR).toBe(env.profileDir);
        expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(childEnv.PATH).toBe('/bin');
        expect(calls[0]!.options!.settingSources).toEqual([]);
        await Promise.resolve();
        expect(calls[0]!.closed).toBe(true);
        expect(calls[0]!.yielded).toBe(false);
    });

    it('a failing call is null, logged, and the query is still closed', async () => {
        const { query, calls } = fakeQuery({ usage: () => Promise.reject(new Error('Unknown control request')) });
        expect(await claudeCodeQuota({ query }).probe!(env, ctx)).toBeNull();
        expect(calls[0]!.closed).toBe(true);
        expect(logs).toEqual([{ level: 'warn', message: 'claude-code quota probe failed; staying passive', data: { environmentId: env.id, error: 'Unknown control request' } }]);
    });

    it('a query that cannot start is null', async () => {
        const query: QuotaQueryFn = () => {
            throw new Error('spawn claude ENOENT');
        };
        expect(await claudeCodeQuota({ query }).probe!(env, ctx)).toBeNull();
        expect(logs[0]!.data!.error).toBe('spawn claude ENOENT');
    });

    it('gives up after timeoutMs and closes the query', async () => {
        const { query, calls } = fakeQuery({ usage: () => new Promise(() => {}) });
        expect(await claudeCodeQuota({ query, timeoutMs: 10 }).probe!(env, ctx)).toBeNull();
        expect(calls[0]!.closed).toBe(true);
        expect(logs[0]!.data!.error).toMatch(/no answer within 10 ms/);
    });

    it('accountInfo failing does not fail the probe', async () => {
        const { query } = fakeQuery({ usage: () => Promise.resolve(usageSignedOut), account: () => Promise.reject(new Error('nope')) });
        expect(await claudeCodeQuota({ query }).probe!(env, ctx)).toMatchObject({ availability: 'not-reported', reason: 'Not signed in to a Claude subscription' });
    });

    it('only probes Claude Code environments', async () => {
        const { query, calls } = fakeQuery();
        expect(await claudeCodeQuota({ query }).probe!({ ...env, runtime: 'anthropic-api' }, ctx)).toBeNull();
        expect(calls).toHaveLength(0);
    });
});

describe('the quota manifest', () => {
    it('is a quota plugin for the claude-code runtime`s source id', () => {
        expect(QUOTA_PLUGINS.map((m) => [m.id, m.kind])).toEqual([[CLAUDE_CODE_QUOTA_ID, 'quota']]);
        expect(claudeCodeQuota().id).toBe(CLAUDE_CODE_QUOTA_ID);
    });
});

describe('anthropicApiQuota', () => {
    it('reports not-reported with its reason, for anthropic-api environments only', async () => {
        const source = anthropicApiQuota();
        expect(await source.probe!({ ...env, runtime: 'anthropic-api' }, ctx)).toEqual({
            sourceId: 'agentic.quota.anthropic-api',
            runtime: 'anthropic-api',
            environmentId: env.id,
            availability: 'not-reported',
            reason: ANTHROPIC_API_QUOTA_REASON,
            windows: [],
            observedAt: AT,
            via: 'probe'
        });
        expect(await source.probe!(env, ctx)).toBeNull();
    });
});
