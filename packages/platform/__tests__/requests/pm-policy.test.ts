/**
 * The project manager policy (#758; PRJ-14): checked before it is stored, a priority cap above normal refused, and a
 * stored policy read back as the default when absent or unreadable.
 */
import { describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type ProjectId } from '@agentic/core';
import { checkedPmPolicy, pmPolicyOf } from '../../src/workspace/pm-policy';
import { PmSpecError } from '../../src/workspace/project-manager';

const good = {
    senders: [
        { project: 'prj_ag', who: 'any-member', mode: 'allowed' },
        { project: '*', who: [{ kind: 'user', userId: 'u1' }], mode: 'ask' }
    ],
    autonomy: { addItems: true, assign: false, priorityUpTo: 'low', declineDuplicates: true, openIssues: false, sendRequests: false },
    weeklySummary: { day: 1, time: '09:30' },
    notifyOnMerge: true
};

const refused = (value: unknown): string => {
    try {
        checkedPmPolicy(value);
    } catch (error) {
        if (error instanceof PmSpecError) return error.message;
        throw error;
    }
    return 'accepted';
};

describe('project manager policy', () => {
    it('accepts a full policy and the default', () => {
        expect(checkedPmPolicy(good)).toEqual(good);
        expect(checkedPmPolicy(PM_POLICY_DEFAULT)).toEqual(PM_POLICY_DEFAULT);
        expect(checkedPmPolicy({ ...good, weeklySummary: null })).not.toHaveProperty('weeklySummary');
    });

    it('PRJ-14: a priority cap of high or urgent is refused', () => {
        expect(refused({ ...good, autonomy: { ...good.autonomy, priorityUpTo: 'high' } })).toMatch(/always come to a person/);
        expect(refused({ ...good, autonomy: { ...good.autonomy, priorityUpTo: 'urgent' } })).toMatch(/priorityUpTo/);
        expect(checkedPmPolicy({ ...good, autonomy: { ...good.autonomy, priorityUpTo: null } }).autonomy.priorityUpTo).toBeNull();
    });

    it('refuses malformed rules, switches and summaries', () => {
        expect(refused(null)).toMatch(/policy/);
        expect(refused({ ...good, senders: 'all' })).toMatch(/senders/);
        expect(refused({ ...good, senders: [{ project: '*', who: 'anyone', mode: 'allowed' }] })).toMatch(/who/);
        expect(refused({ ...good, senders: [{ project: '*', who: 'any-member', mode: 'maybe' }] })).toMatch(/mode/);
        expect(refused({ ...good, senders: [{ project: '*', who: [{ kind: 'robot' }], mode: 'ask' }] })).toMatch(/sender/);
        expect(checkedPmPolicy({ ...good, senders: [{ project: '*', who: [{ kind: 'user', userId: ' u1 ' }], mode: 'ask' }] }).senders[0]!.who).toEqual([{ kind: 'user', userId: 'u1' }]);
        expect(refused({ ...good, autonomy: { ...good.autonomy, assign: 'yes' } })).toMatch(/assign/);
        expect(refused({ ...good, weeklySummary: { day: 7, time: '09:00' } })).toMatch(/day/);
        expect(refused({ ...good, weeklySummary: { day: 1, time: '9am' } })).toMatch(/time/);
        expect(refused({ ...good, notifyOnMerge: undefined })).toMatch(/notifyOnMerge/);
    });

    it('pmPolicyOf: the stored policy, or the default when absent or unreadable', () => {
        expect(pmPolicyOf(undefined)).toBe(PM_POLICY_DEFAULT);
        expect(pmPolicyOf({ pm: { policy: checkedPmPolicy(good) } })).toEqual(good);
        expect(pmPolicyOf({ pm: { policy: { senders: 'x' } as never } })).toBe(PM_POLICY_DEFAULT);
        expect(pmPolicyOf({ pm: { agentId: 'agent_x' as never, policy: { ...PM_POLICY_DEFAULT, senders: [{ project: 'prj_1' as ProjectId, who: 'any-member', mode: 'allowed' }] } } }).senders[0]!.mode).toBe('allowed');
    });
});
