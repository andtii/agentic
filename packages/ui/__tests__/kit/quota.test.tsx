/**
 * Provider limits (#270): the meter reads like Claude Code's `/usage` — label, bar in the status
 * colour, "76% used", the reset time in the viewer's zone — and a panel says when it is stale or
 * why the provider reports nothing (OPS-07, PLG-09).
 */
import type { EnvironmentId, QuotaSnapshot, QuotaWindow } from '@agentic/core';
import { QuotaBadge, QuotaMeter, QuotaPanel, ageText, isQuotaStale, quotaTone, quotaUsedText, resetsText } from '@agentic/ui';
import { mount } from '../helpers';

const TZ = 'Europe/Stockholm';
// 2026-09-19 12:00 in Stockholm (UTC+2).
const NOW = Date.UTC(2026, 8, 19, 10, 0);
const part = (root: ParentNode, scope: string, name: string) => root.querySelector<HTMLElement>(`[data-scope="${scope}"][data-part="${name}"]`);
const parts = (root: ParentNode, scope: string, name: string) => [...root.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${name}"]`)];

const session: QuotaWindow = { id: 'five_hour', label: 'Current session', period: 'session', utilization: 0.19, unit: 'percent', resetsAt: '2026-09-19T11:10:00Z', status: 'ok' };
const week: QuotaWindow = { id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.76, unit: 'percent', resetsAt: '2026-09-22T18:00:00Z', status: 'ok' };
const fable: QuotaWindow = { id: 'seven_day:fable', label: 'Current week (Fable)', period: 'week', scope: { model: 'Fable' }, utilization: 0.8, unit: 'percent', resetsAt: '2026-09-22T18:00:00Z', status: 'warning' };
const snapshot = (patch: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    sourceId: 'agentic.quota.claude-code',
    runtime: 'claude-code',
    environmentId: 'env_1' as EnvironmentId,
    plan: 'max',
    availability: 'reported',
    windows: [session, week, fable],
    observedAt: NOW - 2 * 60_000,
    via: 'probe',
    ...patch
});

describe('quota text', () => {
    it('formats the reset time like /usage, in the given zone: time only today, date and time later', () => {
        expect(resetsText(session.resetsAt, { now: NOW, timeZone: TZ })).toBe('Resets 1:10pm (Europe/Stockholm)');
        expect(resetsText(week.resetsAt, { now: NOW, timeZone: TZ })).toBe('Resets Sep 22 at 8pm (Europe/Stockholm)');
        expect(resetsText(week.resetsAt, { now: NOW, timeZone: 'America/New_York' })).toBe('Resets Sep 22 at 2pm (America/New_York)');
        expect(resetsText(undefined)).toBeUndefined();
        expect(resetsText('not a date')).toBeUndefined();
    });

    it('says the percent used, or that there is no number; maps status to tone', () => {
        expect(quotaUsedText(week)).toBe('76% used');
        expect(quotaUsedText({ utilization: null })).toBe('No number reported');
        expect([quotaTone('ok'), quotaTone('warning'), quotaTone('exhausted'), quotaTone('unknown')]).toEqual(['live', 'needs-you', 'failed', 'muted']);
    });

    it('ages and staleness', () => {
        expect([ageText(5_000), ageText(5 * 60_000), ageText(3 * 3_600_000), ageText(2 * 86_400_000)]).toEqual(['just now', '5 min ago', '3 h ago', '2 d ago']);
        expect(isQuotaStale({ observedAt: NOW - 29 * 60_000 }, NOW)).toBe(false);
        expect(isQuotaStale({ observedAt: NOW - 31 * 60_000 }, NOW)).toBe(true);
    });
});

describe('QuotaMeter', () => {
    it('renders label, a progressbar filled to the percent, "76% used" and the reset line', () => {
        const root = mount(<QuotaMeter window={week} now={NOW} timeZone={TZ} />);
        expect(part(root, 'ag-quota', 'root')!.getAttribute('data-tone')).toBe('live');
        expect(part(root, 'ag-quota', 'label')!.textContent).toBe('Current week (all models)');
        const bar = part(root, 'ag-quota', 'bar')!;
        expect(bar.getAttribute('role')).toBe('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('76');
        expect(part(root, 'ag-quota', 'fill')!.getAttribute('style')).toContain('inline-size: 76%');
        expect(part(root, 'ag-quota', 'used')!.textContent).toBe('76% used');
        expect(part(root, 'ag-quota', 'resets')!.textContent).toBe('Resets Sep 22 at 8pm (Europe/Stockholm)');
    });

    it.each([
        ['warning', 'needs-you'],
        ['exhausted', 'failed'],
        ['unknown', 'muted']
    ] as const)('a %s window is painted %s', (status, tone) => {
        const root = mount(<QuotaMeter window={{ ...week, status }} />);
        expect(part(root, 'ag-quota', 'root')!.getAttribute('data-tone')).toBe(tone);
    });

    it('a window without a number has an empty bar and says so; no reset time, no reset line', () => {
        const root = mount(<QuotaMeter window={{ ...week, utilization: null, status: 'unknown', resetsAt: undefined } as QuotaWindow} />);
        expect(part(root, 'ag-quota', 'bar')!.hasAttribute('aria-valuenow')).toBe(false);
        expect(part(root, 'ag-quota', 'used')!.textContent).toBe('No number reported');
        expect(part(root, 'ag-quota', 'resets')).toBeNull();
    });
});

describe('QuotaPanel', () => {
    it('renders every window with the plan and how old the snapshot is', () => {
        const root = mount(<QuotaPanel snapshot={snapshot()} title="Work" now={NOW} timeZone={TZ} />);
        expect(parts(root, 'ag-quota', 'label').map((l) => l.textContent)).toEqual(['Current session', 'Current week (all models)', 'Current week (Fable)']);
        expect(parts(root, 'ag-quota', 'used').map((l) => l.textContent)).toEqual(['19% used', '76% used', '80% used']);
        expect(part(root, 'ag-quota-panel', 'title')!.textContent).toBe('Work');
        expect(root.textContent).toContain('max');
        expect(part(root, 'ag-quota-panel', 'age')!.textContent).toBe('Updated 2 min ago');
        expect(part(root, 'ag-quota-panel', 'root')!.hasAttribute('data-mod-stale')).toBe(false);
        expect(part(root, 'ag-quota-panel', 'reason')).toBeNull();
    });

    it('marks an old snapshot stale, on the panel and on each meter', () => {
        const root = mount(<QuotaPanel snapshot={snapshot({ observedAt: NOW - 2 * 3_600_000 })} now={NOW} />);
        expect(part(root, 'ag-quota-panel', 'root')!.hasAttribute('data-mod-stale')).toBe(true);
        expect(part(root, 'ag-quota-panel', 'age')!.textContent).toBe('Stale · 2 h ago');
        expect(parts(root, 'ag-quota', 'root').every((m) => m.hasAttribute('data-mod-stale'))).toBe(true);
    });

    it('says why the provider reports nothing — never an empty bar', () => {
        const root = mount(<QuotaPanel snapshot={snapshot({ runtime: 'anthropic-api', plan: undefined, availability: 'not-reported', reason: 'The Anthropic API has per-minute rate limits, not a plan allowance to report', windows: [] })} now={NOW} />);
        expect(part(root, 'ag-quota-panel', 'reason')!.textContent).toBe('Not reported by provider — The Anthropic API has per-minute rate limits, not a plan allowance to report');
        expect(parts(root, 'ag-quota', 'root')).toEqual([]);
        expect(part(root, 'ag-quota-panel', 'root')!.getAttribute('data-availability')).toBe('not-reported');
    });

    it('nothing reported yet', () => {
        const root = mount(<QuotaPanel snapshot={null} />);
        expect(part(root, 'ag-quota-panel', 'reason')!.textContent).toBe('No usage reported yet');
    });

    it('compact shows only the tightest window', () => {
        const root = mount(<QuotaPanel snapshot={snapshot()} compact now={NOW} />);
        expect(parts(root, 'ag-quota', 'label').map((l) => l.textContent)).toEqual(['Current week (Fable)']);
    });
});

describe('QuotaBadge (#315)', () => {
    it('shows the tightest window as a one-line meter, with the reset time as its tooltip', () => {
        const root = mount(<QuotaBadge snapshot={snapshot()} now={NOW} />);
        const meter = part(root, 'ag-quota', 'root')!;
        expect(meter.hasAttribute('data-mod-compact')).toBe(true);
        expect(part(root, 'ag-quota', 'label')!.textContent).toBe('Week · Fable');
        expect(part(root, 'ag-quota', 'used')!.textContent).toBe('80% used');
        expect(part(root, 'ag-quota', 'resets')).toBeNull();
        expect(meter.getAttribute('title')).toMatch(/^Current week \(Fable\) · Resets /);
    });

    it('dims an old snapshot without being given staleMs (QUOTA_STALE_MS by default)', () => {
        const root = mount(<QuotaBadge snapshot={snapshot({ observedAt: NOW - 2 * 3_600_000 })} now={NOW} />);
        expect(part(root, 'ag-quota', 'root')!.hasAttribute('data-mod-stale')).toBe(true);
        expect(part(mount(<QuotaBadge snapshot={snapshot()} now={NOW} />), 'ag-quota', 'root')!.hasAttribute('data-mod-stale')).toBe(false);
    });

    it('says why there is no number: not reported, nothing yet, or the caller\'s note', () => {
        const none = mount(<QuotaBadge snapshot={snapshot({ availability: 'not-reported', reason: 'API-key login', windows: [] })} />);
        expect(none.textContent).toBe('Not reported — API-key login');
        expect(mount(<QuotaBadge snapshot={null} />).textContent).toBe('No usage reported yet');
        expect(mount(<QuotaBadge note="No plan limits · API key" />).textContent).toBe('No plan limits · API key');
        expect(mount(<QuotaBadge />).textContent).toBe('');
    });
});

