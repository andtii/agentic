import type { EnvironmentId, QuotaSnapshot, QuotaWindow } from '../src/index';
import { mergeQuota, tightestWindow } from '../src/index';

const envId = 'env_m1_work' as EnvironmentId;
const win = (id: string, utilization: number | null, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({ id, label: id, period: 'week', utilization, unit: 'percent', status: 'ok', ...extra });
const snap = (windows: readonly QuotaWindow[], extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    sourceId: 'agentic.quota.claude-code',
    runtime: 'claude-code',
    environmentId: envId,
    availability: 'reported',
    windows,
    observedAt: 1,
    via: 'probe',
    ...extra
});

describe('mergeQuota', () => {
    it('takes the next snapshot when there is nothing before it', () => {
        const next = snap([win('five_hour', 0.19)]);
        expect(mergeQuota(undefined, next)).toBe(next);
    });

    it('a stream update replaces only the window it carries and keeps the rest', () => {
        const probe = snap([win('five_hour', 0.19), win('seven_day', 0.76)], { plan: 'max' });
        const stream = snap([win('five_hour', 0.42, { status: 'warning' })], { availability: 'partial', observedAt: 5, via: 'stream' });
        const merged = mergeQuota(probe, stream);
        expect(merged.windows.map((w) => [w.id, w.utilization, w.status])).toEqual([
            ['five_hour', 0.42, 'warning'],
            ['seven_day', 0.76, 'ok']
        ]);
        expect(merged).toMatchObject({ plan: 'max', availability: 'reported', observedAt: 5, via: 'stream' });
    });

    it('appends a window the earlier snapshot did not have', () => {
        const merged = mergeQuota(snap([win('five_hour', 0.1)]), snap([win('seven_day:fable', 0.8)], { availability: 'partial' }));
        expect(merged.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day:fable']);
    });

    it('a partial update on top of nothing reported stays partial', () => {
        expect(mergeQuota(snap([win('a', 0.1)], { availability: 'partial' }), snap([win('b', 0.2)], { availability: 'partial' })).availability).toBe('partial');
    });

    it('not-reported replaces everything, and a later report replaces not-reported', () => {
        const none = snap([], { availability: 'not-reported', reason: 'API-key login' });
        expect(mergeQuota(snap([win('five_hour', 0.5)]), none)).toBe(none);
        const later = snap([win('five_hour', 0.5)], { availability: 'partial' });
        expect(mergeQuota(none, later)).toBe(later);
    });
});

describe('tightestWindow', () => {
    it('picks the highest utilization and skips windows without a number', () => {
        expect(tightestWindow(snap([win('five_hour', 0.19), win('seven_day', 0.76), win('seven_day:fable', 0.8), win('extra', null)]))?.id).toBe('seven_day:fable');
    });

    it('is undefined when no window has a number', () => {
        expect(tightestWindow(snap([win('x', null)]))).toBeUndefined();
        expect(tightestWindow(snap([], { availability: 'not-reported' }))).toBeUndefined();
    });
});
