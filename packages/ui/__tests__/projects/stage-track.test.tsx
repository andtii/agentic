/** `StageTrack` (#726): passed / current / later segments, the current one in its state colour, named in words. */
import type { WorkStageState } from '@agentic/core';
import { StageTrack } from '@agentic/ui';
import { STAGE_STATE_COLOR, stageTrackLabel } from '../../src/projects/StageTrack';
import { mount } from '../helpers';

const GIT = ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'];
const track = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-ag-project="stage-track"]')!;
const segments = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-segment]')];

describe('StageTrack', () => {
    it.each<[WorkStageState, string]>([
        ['working', 'agent working'],
        ['needs-you', 'needs you'],
        ['failed', 'failed'],
        ['done', 'done']
    ])('draws the %s state', (state, words) => {
        const el = track(mount(<StageTrack stages={GIT} stage={3} state={state} />));
        expect(el.getAttribute('data-state')).toBe(state);
        expect(segments(el).map((s) => s.getAttribute('data-segment'))).toEqual(['passed', 'passed', 'passed', 'current', 'later', 'later']);
        const [passed, current, later] = [segments(el)[0]!, segments(el)[3]!, segments(el)[5]!].map((s) => s.getAttribute('style'));
        expect(passed).toContain('var(--color-primary)');
        expect(current).toContain(STAGE_STATE_COLOR[state]);
        expect(later).toContain('var(--ag-line-strong)');
        expect(el.querySelector('[data-stage-name]')!.textContent).toBe('Checks');
        expect(el.querySelector('[data-stage-name]')!.getAttribute('style')).toContain(STAGE_STATE_COLOR[state]);
        expect(el.getAttribute('role')).toBe('img');
        expect(el.getAttribute('aria-label')).toBe(`Checks, stage 4 of 6, ${words}`);
    });

    it('is a 132 px track of 6 px segments with a 3 px gap', () => {
        const el = track(mount(<StageTrack stages={['Ready', 'Do', 'Review', 'Done']} stage={0} state="working" />));
        expect(el.querySelector('[aria-hidden]')!.getAttribute('style')).toContain('inline-size: 132px');
        expect(el.querySelector('[aria-hidden]')!.getAttribute('style')).toContain('gap: 3px');
        expect(segments(el)).toHaveLength(4);
        expect(segments(el)[0]!.getAttribute('style')).toContain('block-size: 6px');
    });

    it('hides the stage name when bare, keeping the accessible name', () => {
        const el = track(mount(<StageTrack stages={GIT} stage={5} state="done" bare />));
        expect(el.querySelector('[data-stage-name]')).toBeNull();
        expect(el.getAttribute('aria-label')).toBe('Merge, stage 6 of 6, done');
    });

    it('clamps an out-of-range stage', () => {
        expect(stageTrackLabel(GIT, 9, 'working')).toBe('Merge, stage 6 of 6, agent working');
        expect(stageTrackLabel(GIT, -1, 'working')).toBe('Ready, stage 1 of 6, agent working');
        expect(stageTrackLabel([], 0, 'failed')).toBe('No stages, failed');
    });
});
