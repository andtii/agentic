import type { EnvironmentId, QuotaSnapshot, QuotaWindow } from '../src/index';
import { applySessionOptions, memberWindows, mergeQuota, tightestWindow, windowMatchesModel } from '../src/index';

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
        expect(mergeQuota(snap([win('five_hour', 0.5)]), none)).toEqual(none);
        // Contradictory input: not-reported never keeps windows.
        expect(mergeQuota(undefined, snap([win('five_hour', 0.5)], { availability: 'not-reported', reason: 'x' })).windows).toEqual([]);
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

describe('memberWindows (#450)', () => {
    const fable = win('seven_day:fable', 1, { status: 'exhausted', scope: { model: 'Fable' } });
    const sonnet = win('seven_day:sonnet', 0.2, { scope: { model: 'Sonnet' } });
    const windows = snap([win('seven_day', 0.77), fable, win('five_hour', 0.12, { period: 'session' }), sonnet]);

    it('another model’s week is not the member’s limit', () => {
        expect(memberWindows(windows, 'claude-sonnet-5').map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day:sonnet']);
        expect(memberWindows(windows, 'opus').map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    });

    it('the model’s own week comes after the shared one', () => {
        expect(memberWindows(windows, 'claude-fable-5-1').map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day:fable']);
        expect(tightestWindow({ windows: memberWindows(windows, 'claude-fable-5-1') })?.id).toBe('seven_day:fable');
        expect(tightestWindow({ windows: memberWindows(windows, 'claude-sonnet-5') })?.id).toBe('seven_day');
    });

    it('without a model only the shared windows count', () => {
        expect(memberWindows(windows).map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    });

    it('matches the scope’s family as a whole word, case-insensitively', () => {
        expect(windowMatchesModel({ scope: { model: 'Fable' } }, 'FABLE')).toBe(true);
        expect(windowMatchesModel({ scope: { model: 'Opus 4.1' } }, 'claude-opus-5')).toBe(true);
        expect(windowMatchesModel({ scope: { model: 'Opus' } }, 'claude-opusx-5')).toBe(false);
        expect(windowMatchesModel({}, undefined)).toBe(true);
    });
});

describe('applySessionOptions (#450)', () => {
    it('sets, clears and leaves keys', () => {
        expect(applySessionOptions(undefined, { model: 'opus' })).toEqual({ model: 'opus' });
        expect(applySessionOptions({ model: 'opus', permissionMode: 'plan' }, { model: null })).toEqual({ permissionMode: 'plan' });
        expect(applySessionOptions({ model: 'opus' }, { model: null })).toBeUndefined();
        expect(applySessionOptions({ model: 'opus' }, { permissionMode: undefined })).toEqual({ model: 'opus' });
    });
});
