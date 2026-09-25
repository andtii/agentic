import type { AgentId, PmPolicy, ProjectId, ProjectPatch, ProjectRecord, Triage } from '../src/index';
import {
    PM_PERSONALITIES,
    PM_PERSONALITY_MAX,
    PM_POLICY_DEFAULT,
    REQUEST_READ_TOOLS,
    REQUEST_TOOLS,
    needsPerson,
    needsPersonReasons,
    pmPersonalityText,
    pmSenderMode,
} from '../src/index';

const forge = { kind: 'agent', agentId: 'agt_forge' as AgentId } as const;

const triage = (over: Partial<Triage> = {}): Triage => ({
    kind: 'bug',
    priority: 'normal',
    similar: [],
    proposedItem: { title: 'batch() keeps pending updates', doneWhen: ['repro passes'] },
    openIssue: false,
    reply: 'Filed.',
    why: '',
    ...over,
});

const policy = (autonomy: Partial<PmPolicy['autonomy']> = {}): PmPolicy => ({ ...PM_POLICY_DEFAULT, autonomy: { ...PM_POLICY_DEFAULT.autonomy, ...autonomy } });

describe('requests (#757)', () => {
    it('names the request tools', () => {
        expect(REQUEST_TOOLS).toEqual(['requests_list', 'requests_triage', 'requests_resolve', 'projects_request']);
        expect(REQUEST_READ_TOOLS).toEqual(['requests_list']);
    });

    describe('needsPerson', () => {
        it('lets the manager act alone within its autonomy', () => {
            expect(needsPerson(triage(), policy())).toBe(false);
            expect(needsPerson(triage({ priority: 'low', proposedItem: { title: 't', doneWhen: [], assignee: forge } }), policy())).toBe(false);
        });

        it('always brings high and urgent priority to a person', () => {
            const all = policy({ addItems: true, assign: true, priorityUpTo: 'normal', openIssues: true });
            expect(needsPersonReasons(triage({ priority: 'high' }), all)).toEqual(['priority']);
            expect(needsPerson(triage({ priority: 'urgent' }), all)).toBe(true);
            // a cap outside the type (stored data) still never lets high through
            const forced = { autonomy: { ...all.autonomy, priorityUpTo: 'urgent' } } as unknown as PmPolicy;
            expect(needsPerson(triage({ priority: 'high' }), forced)).toBe(true);
        });

        it('respects the priority cap', () => {
            expect(needsPersonReasons(triage({ priority: 'normal' }), policy({ priorityUpTo: 'low' }))).toEqual(['priority']);
            expect(needsPersonReasons(triage({ priority: 'low' }), policy({ priorityUpTo: null }))).toEqual(['priority']);
        });

        it('asks when adding, assigning or opening an issue is not allowed', () => {
            const assigned = triage({ proposedItem: { title: 't', doneWhen: [], assignee: forge }, openIssue: true });
            expect(needsPersonReasons(assigned, policy({ addItems: false, assign: false, openIssues: false }))).toEqual(['add-items', 'assign', 'open-issues']);
            expect(needsPerson(assigned, policy({ openIssues: true }))).toBe(false);
        });

        it('treats a duplicate as a decline, not an add', () => {
            const dup = triage({ kind: 'duplicate', proposedItem: undefined });
            expect(needsPerson(dup, policy({ addItems: false }))).toBe(false);
            expect(needsPersonReasons(dup, policy({ declineDuplicates: false }))).toEqual(['decline-duplicates']);
        });
    });

    describe('pmSenderMode', () => {
        const agentic = 'prj_agentic' as ProjectId;
        const zero = 'prj_zero' as ProjectId;
        const p: PmPolicy = {
            ...PM_POLICY_DEFAULT,
            senders: [
                { project: agentic, who: [forge, { kind: 'user', userId: 'u1' }], mode: 'allowed' },
                { project: zero, who: 'any-member', mode: 'allowed' },
                { project: '*', who: 'any-member', mode: 'ask' },
            ],
        };

        it('matches the project rule, then the catch-all', () => {
            expect(pmSenderMode(p, agentic, forge, true)).toBe('allowed');
            expect(pmSenderMode(p, agentic, { kind: 'user', userId: 'u1' }, false)).toBe('allowed');
            expect(pmSenderMode(p, agentic, { kind: 'agent', agentId: 'agt_lint' as AgentId }, true)).toBe('ask');
            expect(pmSenderMode(p, zero, forge, true)).toBe('allowed');
            expect(pmSenderMode(p, 'prj_other' as ProjectId, forge, true)).toBe('ask');
        });

        it('asks when no rule takes the sender', () => {
            expect(pmSenderMode({ senders: [] }, agentic, forge, true)).toBe('ask');
            expect(pmSenderMode({ senders: [{ project: zero, who: 'any-member', mode: 'allowed' }] }, zero, forge, false)).toBe('ask');
        });
    });

    describe('project manager personality (#784)', () => {
        it('ships 4–6 presets with unique ids', () => {
            expect(PM_PERSONALITIES.length).toBeGreaterThanOrEqual(4);
            expect(PM_PERSONALITIES.length).toBeLessThanOrEqual(6);
            expect(new Set(PM_PERSONALITIES.map((x) => x.id)).size).toBe(PM_PERSONALITIES.length);
            for (const x of PM_PERSONALITIES) expect(x.instructions.length).toBeLessThanOrEqual(PM_PERSONALITY_MAX);
        });

        it('returns a preset text', () => {
            const preset = PM_PERSONALITIES[0]!;
            expect(pmPersonalityText({ personality: { preset: preset.id } })).toBe(preset.instructions);
        });

        it('returns custom text trimmed', () => {
            expect(pmPersonalityText({ personality: { custom: '  Be terse.  \n' } })).toBe('Be terse.');
        });

        it('refuses an unknown preset and empty custom text', () => {
            expect(pmPersonalityText({ personality: { preset: 'nope' } })).toBeUndefined();
            expect(pmPersonalityText({ personality: { custom: '   ' } })).toBeUndefined();
        });

        it('caps over-long text', () => {
            const text = pmPersonalityText({ personality: { custom: 'x'.repeat(PM_PERSONALITY_MAX + 500) } });
            expect(text).toHaveLength(PM_PERSONALITY_MAX);
        });

        it('adds pm to ProjectRecord and ProjectPatch', () => {
            const pm: ProjectRecord['pm'] = { agentId: 'agt_nova' as AgentId, policy: PM_POLICY_DEFAULT };
            const patch: ProjectPatch = { pm: { name: 'Nova', personality: { preset: 'calm-organiser' }, skills: [{ id: 'triage' }] } };
            const clear: ProjectPatch = { pm: null };
            expect(pm?.policy.autonomy.priorityUpTo).toBe('normal');
            expect(patch.pm?.skills).toHaveLength(1);
            expect(clear.pm).toBeNull();
        });
    });
});
