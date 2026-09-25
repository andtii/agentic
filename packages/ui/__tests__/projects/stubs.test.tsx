/**
 * The project parts' stubs (#725): each renders a minimal placeholder from its final props (#726 drew five of them), exported from the
 * package barrel. #726 and #745 replace them (and may replace this file).
 */
import type { PullCheck, PullRequest } from '@agentic/core';
import { ChecksBar, ItemGlyph, ProjectSquare, PullCard, SlotMarks, StageTrack, usedSlots } from '@agentic/ui';
import { mount } from '../helpers';

const checks: PullCheck[] = [{ name: 'lint', state: 'passed' }, { name: 'test', state: 'failed' }];
const pull: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 603, title: 'Mobile pass', url: 'https://github.com/andtii/agentic/pull/603', head: 'mobile', base: 'main',
    state: 'open', additions: 10, deletions: 2, files: 3, openedBy: 'forge', openedAt: 0, checks, review: { state: 'requested', reviewers: ['lint'], threads: [] }
};

const part = (host: ParentNode, name: string): HTMLElement => host.querySelector<HTMLElement>(`[data-ag-project="${name}"]`)!;

describe('project part stubs', () => {
    it('render from their props', () => {
        const host = mount(
            <div>
                <ProjectSquare name="agentic" color="violet" size={20} />
                <StageTrack stages={['Ready', 'Do', 'Review', 'Done']} stage={1} state="working" />
                <ItemGlyph state="blocked" label="Blocked" />
                <SlotMarks ui={{ section: { label: 'Plan', icon: 'plan' }, workStages: ['a', 'b'] }} instructions />
                <ChecksBar checks={checks} />
                <PullCard pull={pull} href="/projects/p/work/pr:603" surface="home" />
            </div>
        );
        expect(part(host, 'square').textContent).toBe('A');
        expect(part(host, 'stage-track').textContent).toBe('Do');
        expect(part(host, 'item-glyph').getAttribute('aria-label')).toBe('Blocked');
        expect(part(host, 'slot-marks').getAttribute('data-used')).toBe('section workStages tools');
        expect(part(host, 'checks-bar').textContent).toBe('1 failing');
        expect(part(host, 'pull-card').querySelector('a')!.getAttribute('href')).toBe('/projects/p/work/pr:603');
    });

    it('usedSlots reads the five slots in mark order', () => {
        expect(usedSlots(undefined)).toEqual([]);
        expect(usedSlots({ overviewCard: { title: 'Code' }, chatRefPrefixes: ['pr:'], tools: ['git'] })).toEqual(['overviewCard', 'chatRefPrefixes', 'tools']);
    });
});
