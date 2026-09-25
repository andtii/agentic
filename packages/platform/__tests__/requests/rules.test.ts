/**
 * The Requests rules (#758; PRJ-14/PRJ-15): the state machine on a bare book — who may move a request, where the
 * sender rules and the manager's policy send it, and what is final.
 */
import { describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type PlanActor, type PmPolicy, type ProjectId, type Triage, type WorkspaceId } from '@agentic/core';
import { admit, answer, checkResolution, checkTriage, emptyBook, receive, RequestRuleError, resolve, triage, wantsTurn, type RequestCall, type RequestsBook } from '../../src/requests/rules';

const ws = 'ws_1' as WorkspaceId;
const TARGET = 'prj_sx' as ProjectId;
const SOURCE = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const nova: PlanActor = { kind: 'agent', agentId: NOVA };
const forge: PlanActor = { kind: 'agent', agentId: FORGE };
const person: PlanActor = { kind: 'user', userId: 'u1' };

const allowAg: PmPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: SOURCE, who: 'any-member', mode: 'allowed' }, ...PM_POLICY_DEFAULT.senders] };

const call = (actor: PlanActor, policy: PmPolicy = allowAg, manager: AgentId | null = NOVA): RequestCall => ({ now: 1000, actor, manager, policy });

const bug: Triage = {
    kind: 'bug',
    priority: 'normal',
    similar: [],
    proposedItem: { title: 'batch() drops nested effects', doneWhen: ['test passes'], assignee: { kind: 'agent', agentId: 'agent_core' as AgentId } },
    openIssue: false,
    reply: 'Filed, on it.',
    why: ''
};

function book(): RequestsBook {
    return emptyBook(ws, TARGET);
}

const codeOf = (fn: () => unknown): string | undefined => {
    try {
        fn();
    } catch (error) {
        return error instanceof RequestRuleError ? error.code : String(error);
    }
    return undefined;
};

const send = (b: RequestsBook, c: RequestCall = call(forge), isMember = true) => receive(b, c, { fromProject: SOURCE, title: 'batch() bug', body: 'nested batch drops effects', refs: ['pr:604'] }, isMember).value;

describe('Requests rules', () => {
    it('receive: an allowed sender goes to triage; "ask" (the default) and no manager go to a person', () => {
        const b = book();
        const out = receive(b, call(forge), { fromProject: SOURCE, title: 'batch() bug', body: 'nested batch drops effects', refs: ['pr:604'] }, true);
        const allowed = out.value;
        expect(allowed).toMatchObject({ id: 'req_1', state: 'triaging', toProject: TARGET, sender: forge, refs: [{ kind: 'pr', n: 604 }] });
        expect(wantsTurn(allowed, out.change, { manager: NOVA })).toBe(true);
        expect(wantsTurn(allowed, { op: 'triaged' }, { manager: NOVA })).toBe(false);
        expect(send(b, call(forge, PM_POLICY_DEFAULT))).toMatchObject({ id: 'req_2', state: 'needs-you', needs: 'admit', reasons: ['sender'] });
        // A non-member of the sending project is not "any-member": it asks.
        expect(send(b, call(forge), false)).toMatchObject({ state: 'needs-you', needs: 'admit' });
        const orphan = send(b, call(forge, allowAg, null));
        expect(orphan).toMatchObject({ state: 'needs-you', needs: 'decision', reasons: ['no-manager'] });
        expect(wantsTurn(orphan, { op: 'received' }, { manager: null })).toBe(false);
        expect(codeOf(() => receive(b, call(forge), { fromProject: TARGET, title: 'x', body: 'y' }, true))).toBe('invalid');
        expect(codeOf(() => receive(b, call(forge), { fromProject: SOURCE, title: '', body: 'y' }, true))).toBe('invalid');
    });

    it('admit: only a person, only a request waiting to be let in', () => {
        const b = book();
        const r = send(b, call(forge, PM_POLICY_DEFAULT));
        expect(codeOf(() => admit(b, call(nova, PM_POLICY_DEFAULT), r.id))).toBe('forbidden');
        expect(admit(b, call(person, PM_POLICY_DEFAULT), r.id).value).toMatchObject({ state: 'triaging' });
        expect(r.needs).toBeUndefined();
        expect(codeOf(() => admit(b, call(person, PM_POLICY_DEFAULT), r.id))).toBe('wrong-state');
    });

    it('triage: the manager only; within its policy it keeps the request, else it goes to Needs you with why', () => {
        const b = book();
        const r = send(b);
        expect(codeOf(() => triage(b, call(forge), r.id, bug))).toBe('forbidden');
        expect(codeOf(() => triage(b, call(person), r.id, bug))).toBe('forbidden');
        expect(triage(b, call(nova), r.id, bug).value).toMatchObject({ state: 'triaging', triage: { kind: 'bug', why: '' } });

        const urgent = send(b);
        const out = triage(b, call(nova), urgent.id, { ...bug, priority: 'urgent' }).value;
        expect(out).toMatchObject({ state: 'needs-you', needs: 'decision', reasons: ['priority'] });
        expect(out.triage!.why).toMatch(/priority/);

        // Autonomy switched off: adding and assigning come to a person.
        const strict: PmPolicy = { ...allowAg, autonomy: { ...allowAg.autonomy, addItems: false, assign: false } };
        const held = send(b, call(forge, strict));
        expect(triage(b, call(nova, strict), held.id, bug).value).toMatchObject({ state: 'needs-you', reasons: ['add-items', 'assign'] });
        // Not triaging any more.
        expect(codeOf(() => triage(b, call(nova, strict), held.id, bug))).toBe('wrong-state');
    });

    it('checkTriage refuses bad triages and drops a duplicate\'s proposed item', () => {
        expect(codeOf(() => checkTriage({ ...bug, kind: 'nope' }))).toBe('invalid');
        expect(codeOf(() => checkTriage({ ...bug, priority: 'critical' }))).toBe('invalid');
        expect(codeOf(() => checkTriage({ ...bug, reply: '' }))).toBe('invalid');
        expect(codeOf(() => checkTriage({ ...bug, kind: 'duplicate' }))).toBe('invalid');
        const dup = checkTriage({ ...bug, kind: 'duplicate', similar: [{ ref: '#9', note: 'same cause' }] });
        expect(dup.proposedItem).toBeUndefined();
        expect(dup.similar).toEqual([{ ref: { kind: 'item', n: 9 }, note: 'same cause' }]);
        expect(codeOf(() => checkTriage({ ...bug, proposedItem: { ...bug.proposedItem, assignee: { kind: 'robot' } } }))).toBe('invalid');
    });

    it('resolve: the manager accepts only what its policy passes; a person accepts anything open, with an edit', () => {
        const b = book();
        const r = send(b);
        expect(codeOf(() => checkResolution(b, call(nova), r.id, { action: 'accept' }))).toBe('wrong-state');
        triage(b, call(nova), r.id, bug);
        expect(codeOf(() => checkResolution(b, call(forge), r.id, { action: 'accept' }))).toBe('forbidden');
        expect(codeOf(() => checkResolution(b, call(nova), r.id, { action: 'accept', item: { title: 'x', doneWhen: [] } }))).toBe('forbidden');
        expect(checkResolution(b, call(nova), r.id, { action: 'accept' })).toEqual({ item: bug.proposedItem, openIssue: false });
        expect(resolve(b, call(nova), r.id, { action: 'accept' }, 14).value).toMatchObject({ state: 'accepted', resultItem: 14 });
        expect(codeOf(() => checkResolution(b, call(person), r.id, { action: 'decline', reason: 'x' }))).toBe('final');

        const high = send(b);
        triage(b, call(nova), high.id, { ...bug, priority: 'high' });
        expect(codeOf(() => checkResolution(b, call(nova), high.id, { action: 'accept' }))).toBe('wrong-state');
        const edited = { title: 'batch() nested', doneWhen: ['fixed'], phase: 2 };
        expect(checkResolution(b, call(person), high.id, { action: 'accept', item: edited, planId: 'plan-1' })).toEqual({ item: edited, openIssue: false, planId: 'plan-1' });
        const bare = send(b, call(forge, PM_POLICY_DEFAULT));
        expect(codeOf(() => checkResolution(b, call(person), bare.id, { action: 'accept' }))).toBe('invalid');
    });

    it('decline: the manager only a duplicate its policy lets it decline; a person always, with a reason', () => {
        const b = book();
        const r = send(b);
        triage(b, call(nova), r.id, bug);
        expect(codeOf(() => checkResolution(b, call(nova), r.id, { action: 'decline', reason: 'no' }))).toBe('needs-person');
        const d = send(b);
        triage(b, call(nova), d.id, { ...bug, kind: 'duplicate', similar: [{ ref: '#9' }] });
        const noDup: PmPolicy = { ...allowAg, autonomy: { ...allowAg.autonomy, declineDuplicates: false } };
        expect(codeOf(() => checkResolution(b, call(nova, noDup), d.id, { action: 'decline', reason: 'dup of #9' }))).toBe('needs-person');
        expect(checkResolution(b, call(nova), d.id, { action: 'decline', reason: 'dup of #9' })).toBeNull();
        expect(resolve(b, call(nova), d.id, { action: 'decline', reason: ' dup of #9 ' }).value).toMatchObject({ state: 'declined', declineReason: 'dup of #9' });
        expect(codeOf(() => checkResolution(b, call(person), r.id, { action: 'decline', reason: '' }))).toBe('invalid');
        expect(resolve(b, call(person), r.id, { action: 'decline', reason: 'not ours' }).value.state).toBe('declined');
    });

    it('ask for more → the sender answers → back to triage, the old triage dropped', () => {
        const b = book();
        const r = send(b);
        triage(b, call(nova), r.id, bug);
        expect(checkResolution(b, call(nova), r.id, { action: 'ask', question: 'Which version?' })).toBeNull();
        expect(resolve(b, call(nova), r.id, { action: 'ask', question: 'Which version?' }).value).toMatchObject({ state: 'asked-for-more', question: 'Which version?' });
        expect(codeOf(() => checkResolution(b, call(nova), r.id, { action: 'ask', question: 'again?' }))).toBe('wrong-state');
        expect(codeOf(() => answer(b, call(nova), r.id, '0.4'))).toBe('forbidden');
        const back = answer(b, call(forge), r.id, 'signalx 0.4.2').value;
        expect(back).toMatchObject({ state: 'triaging' });
        expect(back.triage).toBeUndefined();
        expect(back.question).toBeUndefined();
        expect(back.body).toMatch(/@agent_forge: signalx 0\.4\.2$/);
        expect(codeOf(() => answer(b, call(forge), r.id, 'more'))).toBe('wrong-state');
        expect(codeOf(() => checkResolution(b, call(person), r.id, { action: 'nope' }))).toBe('invalid');
    });
});
