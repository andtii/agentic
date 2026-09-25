/** The projects redesign contract (#724): feature ui slots, work stages, pull request blockers, member limits. */
import { describe, expect, it } from 'vitest';
import {
    isProjectFeatureManifest,
    memberLimit,
    MEMBER_LIMIT_DEFAULT,
    MEMBER_LIMIT_MAX,
    projectFeatureUiError,
    pullBlockers,
    workStagesFor,
    WORK_STAGES_FALLBACK,
    type AgentId,
    type PluginManifest,
    type ProjectFeatureUi,
    type PullRequest
} from '../src/index';

const manifest = (extra: Record<string, unknown> = {}): PluginManifest =>
    ({ id: 'agentic.feature.x', name: 'X', version: '0.1.0', kind: 'project-feature', config: {}, projectSettings: {}, ...extra }) as unknown as PluginManifest;

describe('ProjectFeatureUi', () => {
    it('accepts a full ui block and a manifest without one', () => {
        const ui: ProjectFeatureUi = {
            section: { label: 'Code', icon: 'code', badge: 'open-items' },
            overviewCard: { title: 'Code' },
            workStages: ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'],
            chatRefPrefixes: ['pr:'],
            tools: ['plan'],
            needs: ['folder']
        };
        expect(projectFeatureUiError(ui)).toBeUndefined();
        expect(isProjectFeatureManifest(manifest({ ui, category: 'code' }))).toBe(true);
        expect(isProjectFeatureManifest(manifest())).toBe(true);
    });

    it('refuses a malformed ui block, and the manifest with it', () => {
        expect(projectFeatureUiError('x')).toBe('ui must be an object');
        expect(projectFeatureUiError({ section: { label: 'Code' } })).toMatch(/section/);
        expect(projectFeatureUiError({ section: { label: 'Code', icon: 'c', badge: 'lots' } })).toMatch(/section/);
        expect(projectFeatureUiError({ section: { label: '', icon: 'c' } })).toMatch(/section/);
        expect(projectFeatureUiError({ overviewCard: {} })).toMatch(/overviewCard/);
        expect(projectFeatureUiError({ overviewCard: { title: '' } })).toMatch(/overviewCard/);
        expect(projectFeatureUiError({ workStages: ['Only'] })).toMatch(/workStages/);
        expect(projectFeatureUiError({ chatRefPrefixes: [''] })).toMatch(/chatRefPrefixes/);
        expect(projectFeatureUiError({ tools: [1] })).toMatch(/tools/);
        expect(projectFeatureUiError({ needs: ['gpu'] })).toMatch(/needs/);
        expect(isProjectFeatureManifest(manifest({ ui: { workStages: [] } }))).toBe(false);
        expect(isProjectFeatureManifest(manifest({ category: 'not-a-category' }))).toBe(false);
    });
});

describe('workStagesFor', () => {
    const uis: Record<string, ProjectFeatureUi> = { git: { workStages: ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'] }, docs: { section: { label: 'Docs', icon: 'doc' } } };
    it('takes the first enabled feature that declares stages', () => {
        expect(workStagesFor(['docs', 'git'], (id) => uis[id])).toEqual(uis.git!.workStages);
    });
    it('falls back to Ready, Do, Review, Done', () => {
        expect(workStagesFor(['docs'], (id) => uis[id])).toBe(WORK_STAGES_FALLBACK);
        expect(workStagesFor([], () => undefined)).toEqual(['Ready', 'Do', 'Review', 'Done']);
    });
});

describe('pullBlockers', () => {
    const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
        provider: 'github',
        repo: 'andtii/agentic',
        number: 603,
        title: 'Usage rings',
        url: 'https://github.com/andtii/agentic/pull/603',
        head: '603-usage-rings',
        base: 'main',
        state: 'open',
        additions: 184,
        deletions: 41,
        files: 6,
        openedBy: 'forge',
        openedAt: 0,
        checks: [],
        review: { state: 'approved', reviewers: [], threads: [] },
        mergeable: true,
        ...over
    });

    it('is empty when it can merge, and for a closed or merged PR', () => {
        expect(pullBlockers(pr())).toEqual([]);
        expect(pullBlockers(pr({ state: 'merged', mergeable: false }))).toEqual([]);
    });

    it('names every blocker, counted', () => {
        const blocked = pr({
            checks: [
                { name: 'size', state: 'failed' },
                { name: 'e2e', state: 'running' },
                { name: 'unit', state: 'passed' }
            ],
            review: {
                state: 'requested',
                reviewers: ['Lint'],
                threads: [
                    { id: 't1', author: 'lint', body: 'a', state: 'open' },
                    { id: 't2', author: 'lint', body: 'b', state: 'replying' },
                    { id: 't3', author: 'lint', body: 'c', state: 'resolved' }
                ]
            }
        });
        expect(pullBlockers(blocked)).toEqual(['1 failing check', '1 check running', '2 open threads', 'Lint has not approved']);
        expect(pullBlockers(pr({ review: { state: 'requested', reviewers: ['Lint', 'Nova'], threads: [] } }))).toEqual(['Lint, Nova have not approved']);
        expect(pullBlockers(pr({ draft: true, mergeable: false, review: { state: 'changes-requested', reviewers: [], threads: [] } }))).toEqual(['draft', 'conflicts with the base', 'changes requested']);
    });
});

describe('memberLimit', () => {
    const a = 'agent_a' as AgentId;
    const b = 'agent_b' as AgentId;
    it('defaults to one, and clamps what the project sets', () => {
        expect(memberLimit({ members: { agentIds: [a], coordinator: null } }, a)).toBe(MEMBER_LIMIT_DEFAULT);
        const project = { members: { agentIds: [a, b], coordinator: a, limits: { [a]: 3, [b]: 99 } } };
        expect(memberLimit(project, a)).toBe(3);
        expect(memberLimit(project, b)).toBe(MEMBER_LIMIT_MAX);
        expect(memberLimit({ members: { agentIds: [a], coordinator: null, limits: { [a]: 0 } } }, a)).toBe(MEMBER_LIMIT_DEFAULT);
    });
});
