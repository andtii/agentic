/**
 * #870: the thread places a request card's halves by time — `part="request"` draws the request card alone,
 * `part="result"` the accept divider and the result card alone, and nothing before the request is accepted.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ChatId, ProjectId, ProjectRequest } from '@agentic/core';
import { RequestCard, acceptedAt } from '../../src/pages/chat/entries/RequestCard';
import { mountAt, text } from './helpers';

const time = (at: number): string => `t${at}`;
const base: ProjectRequest = {
    id: 'req_1',
    fromProject: 'p_agentic' as ProjectId,
    fromChat: 'c_rings' as ChatId,
    sender: { kind: 'agent', agentId: 'forge' as AgentId },
    toProject: 'p_signalx' as ProjectId,
    title: 'batch() drops updates when an effect throws',
    body: '',
    refs: [],
    state: 'triaging',
    createdAt: 1,
    updatedAt: 9
};
const accepted: ProjectRequest = { ...base, state: 'accepted', resultItem: 14 };

describe('RequestCard halves (#870)', () => {
    it('part="request" draws the request card and no divider or result', async () => {
        const root = await mountAt('/chats/c_rings', <RequestCard request={accepted} part="request" toProjectName="SignalX" managerName="Nova" time={time} />);
        expect(text(root.querySelector('[data-requests-why]'))).toBe('ACCEPTED → SIGNALX#14');
        expect(root.querySelector('[data-chat-request-divider]')).toBeNull();
        expect(root.querySelector('[data-chat-request-result]')).toBeNull();
    });

    it('part="result" draws the divider and the result card alone', async () => {
        const root = await mountAt('/chats/c_rings', <RequestCard request={accepted} part="result" toProjectName="SignalX" managerName="Nova" time={time} />);
        expect(root.querySelector('[data-requests-triage-head]')).toBeNull();
        expect(text(root.querySelector('[data-chat-request-divider]'))).toBe('accepted in SignalX · t9');
        expect(root.querySelector('[data-chat-request-result]')).not.toBeNull();
    });

    it('part="result" draws nothing before the accept', async () => {
        const root = await mountAt('/chats/c_rings', <RequestCard request={base} part="result" toProjectName="SignalX" managerName="Nova" time={time} />);
        expect(root.querySelector('[data-chat-request]')).toBeNull();
    });

    it('acceptedAt: the accept instant once filed, else nothing', () => {
        expect(acceptedAt(accepted)).toBe(9);
        expect(acceptedAt(base)).toBeUndefined();
        expect(acceptedAt({ ...base, state: 'accepted' })).toBeUndefined();
    });
});
