/**
 * The PMChat pieces on the page (#762; PRJ-16): the request card follows its request in place — the pill, then the
 * accept divider and the result card with Track → Links; the members panel marks a visiting manager with its project
 * and `project manager, visiting`; the Across projects card lists the linked items, and is absent with none.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ChatId, ProjectId, ProjectRequest } from '@agentic/core';
import { VISITING_ROLE, type Visitor } from '@agentic/platform';
import { ContextPanel } from '../../src/pages/chat/ContextPanel';
import { RequestCard } from '../../src/pages/chat/entries/RequestCard';
import { AcrossProjects } from '../../src/pages/chat/panels/AcrossProjects';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatSummary } from '../../src/mock/workspace';
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
    refs: [{ kind: 'file', path: 'usage.test.ts', from: 12, to: 40 }, { kind: 'project-item', project: 'agentic', n: 16 }],
    state: 'triaging',
    createdAt: 1,
    updatedAt: 9
};

describe('RequestCard (#762)', () => {
    it('reads the manager triaging, with the refs and See triage — no result yet', async () => {
        const root = await mountAt('/chats/c_rings', <RequestCard request={base} toProjectName="SignalX" managerName="Nova" homeProjectName="agentic" time={time} />);
        expect(text(root.querySelector('[data-requests-triage-head]'))).toContain('Request to SignalX');
        expect(text(root.querySelector('[data-requests-why]'))).toBe('NOVA TRIAGING');
        expect([...root.querySelectorAll('[data-requests-ref]')].map(text)).toEqual(['usage.test.ts:12-40', 'agentic#16']);
        expect(root.querySelector('a[href="/projects/p_signalx/requests"]')?.textContent).toBe('See triage');
        expect(root.querySelector('[data-chat-request-result]')).toBeNull();
    });

    it('once accepted: ACCEPTED → SIGNALX#14, the divider, and the result card tracking to Links', async () => {
        const accepted: ProjectRequest = { ...base, state: 'accepted', resultItem: 14 };
        const root = await mountAt('/chats/c_rings', <RequestCard request={accepted} toProjectName="SignalX" managerName="Nova" homeProjectName="agentic" time={time} />);
        expect(text(root.querySelector('[data-requests-why]'))).toBe('ACCEPTED → SIGNALX#14');
        expect(text(root.querySelector('[data-chat-request-divider]'))).toBe('accepted in SignalX · t9');
        const result = root.querySelector('[data-chat-request-result]')!;
        expect(text(result.querySelector('[data-requests-chip]'))).toBe('signalx#14');
        expect(text(result)).toContain('agentic#16 waits on it');
        expect(result.querySelector('a[href="/projects/links"]')?.textContent).toBe('Track');
    });
});

describe('Across projects and visitor chips (#762)', () => {
    it('lists each linked item with its state and links to Links; renders nothing with none', async () => {
        const root = await mountAt('/chats/c_rings', <AcrossProjects items={[{ ref: 'signalx#14', n: 14, state: 'filed' }, { ref: 'agentic#16', n: 16, state: 'waits' }]} />);
        expect([...root.querySelectorAll('[data-across-item]')].map((li) => [text(li.querySelector('[data-requests-chip]')), text(li.querySelector('[data-requests-mono]'))])).toEqual([['signalx#14', 'filed'], ['agentic#16', 'waits']]);
        expect(root.querySelector('[data-across-projects] a[href="/projects/links"]')).not.toBeNull();
        const empty = await mountAt('/chats/c_rings', <AcrossProjects items={[]} />);
        expect(empty.querySelector('[data-across-projects]')).toBeNull();
    });

    it('a visiting manager’s member card carries its project and “project manager, visiting”', async () => {
        const forge: AgentIdentity = { id: 'forge', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };
        const nova: AgentIdentity = { id: 'nova', name: 'Nova', role: 'Project manager', hue: 3, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };
        const chat: MockChatSummary = {
            id: 'c_rings',
            title: 'Usage rings',
            members: [{ agentId: 'forge', status: 'idle', history: { access: 'all' } }, { agentId: 'nova', status: 'idle', history: { access: 'from', at: 1 } }],
            lastLine: '',
            unread: 0,
            waiting: false,
            updatedAt: 0
        };
        const visitor: Visitor = { agentId: 'nova' as AgentId, projectId: 'p_signalx' as ProjectId, projectName: 'SignalX', role: VISITING_ROLE };
        const root = await mountAt(
            '/chats/c_rings',
            <ContextPanel chat={chat} tasks={[]} lookup={lookupOver({ forge, nova })} visitorOf={(id) => (id === 'nova' ? visitor : undefined)} across={[{ ref: 'signalx#14', n: 14, state: 'filed' }]} />
        );
        const roles = [...root.querySelectorAll('[data-member] [data-member-role]')].map(text);
        expect(roles).toEqual(['Builder', 'project manager, visiting SignalX']);
        expect(root.querySelector('[data-member-visiting] [data-requests-chip="project"]')?.textContent).toBe('SignalX');
        expect(root.querySelector('[data-across-projects]')).not.toBeNull();
    });
});
