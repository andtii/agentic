/**
 * #943: the chat's context panel hands its agent lookup to Across projects, so a linked item's live line names who
 * works it (`Forge working · PR signalx#88`), not only its state.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentId, PlanItem } from '@agentic/core';
import { ContextPanel } from '../../src/pages/chat/ContextPanel';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatSummary } from '../../src/mock/workspace';
import { mountAt, text } from './helpers';

vi.mock('../../src/pages/projects/work/live', async (original) => {
    const actual = await original<typeof import('../../src/pages/projects/work/live')>();
    const working: PlanItem = { id: 14, title: 'Fix batch()', state: 'claimed', claim: { agentId: 'forge' as AgentId, leaseUntil: 2 }, after: [], touches: [], refs: [{ kind: 'pr', n: 88 }], doneWhen: [], activity: [] } as PlanItem;
    return { ...actual, usePlanItems: () => () => [working] };
});

describe('Across projects in the context panel (#943)', () => {
    it("names the agent working the linked item, from the chat's lookup", async () => {
        const forge: AgentIdentity = { id: 'forge', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };
        const chat: MockChatSummary = { id: 'c_rings', title: 'Usage rings', members: [{ agentId: 'forge', status: 'idle', history: { access: 'all' } }], lastLine: '', unread: 0, waiting: false, updatedAt: 0 };
        const root = await mountAt('/chats/c_rings', <ContextPanel chat={chat} tasks={[]} lookup={lookupOver({ forge })} across={[{ ref: 'signalx#14', projectId: 'p_signalx', n: 14, state: 'filed' }] as never} />);
        expect(text(root.querySelector('[data-across-item] [data-requests-mono]'))).toBe('Forge working · PR signalx#88');
    });
});
