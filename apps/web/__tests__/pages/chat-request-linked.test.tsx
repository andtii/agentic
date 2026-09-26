/**
 * #931: the request's result card and Across projects read the linked item's real state and PR
 * (`Forge working · PR signalx#88`), and the accept divider names who accepted (`you accepted in SignalX`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ChatId, PlanItem, ProjectId, ProjectRequest } from '@agentic/core';
import { RequestCard, acceptedByText, linkedItemLine } from '../../src/pages/chat/entries/RequestCard';
import { AcrossProjects } from '../../src/pages/chat/panels/AcrossProjects';
import { mountAt, text } from './helpers';

const FORGE = 'agent_forge' as AgentId;
const names = (id: AgentId): string | undefined => (id === FORGE ? 'Forge' : undefined);
const item = (over: Partial<PlanItem> = {}): PlanItem => ({ id: 14, title: 'Fix batch()', state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const accepted: ProjectRequest = {
    id: 'req_1',
    fromProject: 'p_agentic' as ProjectId,
    fromChat: 'c_rings' as ChatId,
    sender: { kind: 'agent', agentId: FORGE },
    toProject: 'p_signalx' as ProjectId,
    title: 'batch() drops nested effects',
    body: '',
    refs: [],
    state: 'accepted',
    resultItem: 14,
    createdAt: 1,
    updatedAt: 9
};

describe('linked items (#931)', () => {
    it('linkedItemLine: who works it and its latest PR in the project ref form', () => {
        const working = item({ state: 'claimed', claim: { agentId: FORGE, leaseUntil: 2 }, refs: [{ kind: 'pr', n: 80 }, { kind: 'pr', n: 88 }] });
        expect(linkedItemLine(working, 'SignalX', names)).toBe('Forge working · PR signalx#88');
        expect(linkedItemLine(working, 'SignalX')).toBe('working · PR signalx#88');
        expect(linkedItemLine(item({ state: 'blocked' }), 'SignalX', names)).toBe('blocked');
        expect(linkedItemLine(item({ state: 'done', refs: [{ kind: 'pr', n: 88 }] }), 'SignalX', names)).toBe('done · PR signalx#88');
        expect(linkedItemLine(item({ state: 'needs-you' }), 'SignalX')).toBe('needs you');
    });

    it('acceptedByText: a person is you, an agent the manager, else no one named', () => {
        expect(acceptedByText({ ...accepted, acceptedBy: { kind: 'user', userId: 'u1' } } as ProjectRequest, 'SignalX', 'Nova')).toBe('you accepted in SignalX');
        expect(acceptedByText({ ...accepted, acceptedBy: { kind: 'agent', agentId: 'nova' } } as ProjectRequest, 'SignalX', 'Nova')).toBe('Nova accepted in SignalX');
        expect(acceptedByText(accepted, 'SignalX', 'Nova')).toBe('accepted in SignalX');
    });

    it('the divider names who accepted', async () => {
        const root = await mountAt('/chats/c_rings', <RequestCard request={{ ...accepted, acceptedBy: { kind: 'user', userId: 'u1' } } as ProjectRequest} part="result" toProjectName="SignalX" managerName="Nova" time={(at) => `t${at}`} />);
        expect(text(root.querySelector('[data-chat-request-divider]'))).toBe('you accepted in SignalX · t9');
    });

    it('Across projects falls back to the request view while the item is not read', async () => {
        const root = await mountAt('/chats/c_rings', <AcrossProjects items={[{ ref: 'signalx#14', projectId: 'p_signalx' as ProjectId, n: 14, state: 'filed' }, { ref: 'agentic#16', n: 16, state: 'waits' }]} agentName={names} />);
        expect([...root.querySelectorAll('[data-across-item]')].map((li) => text(li.querySelector('[data-requests-mono]')))).toEqual(['filed', 'waits']);
    });
});
