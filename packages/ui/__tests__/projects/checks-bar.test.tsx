/** `ChecksBar` (#726): passed / running / failed in proportion, with the summary in words. */
import type { PullCheck, PullCheckState } from '@agentic/core';
import { ChecksBar } from '@agentic/ui';
import { checksSummary } from '../../src/projects/ChecksBar';
import { mount } from '../helpers';

const checks = (...states: PullCheckState[]): PullCheck[] => states.map((state, i) => ({ name: `c${i}`, state }));
const bar = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-ag-project="checks-bar"]')!;
const segments = (el: HTMLElement): string[] => [...el.querySelectorAll('[data-segment]')].map((s) => `${s.getAttribute('data-segment')}:${/flex-grow: (\d+)/.exec(s.getAttribute('style')!)![1]}`);
const summary = (el: HTMLElement): string => el.querySelector('[data-checks-summary]')!.textContent!;

describe('ChecksBar', () => {
    it('all passed', () => {
        const el = bar(mount(<ChecksBar checks={checks('passed', 'passed', 'passed')} />));
        expect(segments(el)).toEqual(['passed:3']);
        expect(summary(el)).toBe('3/3 passed');
        expect(el.querySelector('[data-tone="passed"]')!.getAttribute('style')).toContain('var(--ag-text-muted)');
    });

    it('failing and running', () => {
        const el = bar(mount(<ChecksBar checks={checks(...Array<PullCheckState>(7).fill('passed'), 'running', 'failed')} />));
        expect(segments(el)).toEqual(['passed:7', 'running:1', 'failed:1']);
        expect(summary(el)).toBe('1 failing · 1 running');
        expect(el.querySelector('[data-tone="failed"]')!.getAttribute('style')).toContain('var(--color-error)');
        expect(el.querySelector('[data-tone="running"]')!.getAttribute('style')).toContain('var(--color-info)');
    });

    it('queued counts with running in the bar and in words', () => {
        const el = bar(mount(<ChecksBar checks={checks('passed', 'queued', 'queued')} />));
        expect(segments(el)).toEqual(['passed:1', 'running:2']);
        expect(summary(el)).toBe('2 queued');
    });

    it('no checks', () => {
        const el = bar(mount(<ChecksBar checks={[]} />));
        expect(segments(el)).toEqual([]);
        expect(summary(el)).toBe('no checks');
        expect(el.querySelector('[aria-hidden="true"]')!.getAttribute('style')).toContain('inline-size: 96px');
    });

    it('leaves skipped checks out of the count', () => {
        expect(checksSummary(checks('passed', 'skipped'))).toEqual([{ tone: 'passed', text: '1/1 passed' }]);
        expect(checksSummary(checks('skipped'))).toEqual([{ tone: 'none', text: '1 skipped' }]);
    });
});
