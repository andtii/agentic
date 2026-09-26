/**
 * A project chat's context (#940, board PMChat): the enabled features' ref prefixes as context chips and composer
 * suggestions (`#` plan items, `pr:` pull requests), and the To row naming a visiting manager before it joins, with
 * its project chip and the bring-in hint.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanItem, ProjectId, PullRequest } from '@agentic/core';
import { VISITING_ROLE, type Visitor } from '@agentic/platform';
import { BRING_IN_HINT, chatAddressing, chatRefSources, chipPrefixes, contextChips, type ChatFeatureView } from '../../src/pages/chat/project-context';
import { ContextChips } from '../../src/pages/chat/panels/ContextChips';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatMember } from '../../src/mock/workspace';
import { mountAt, text } from '../pages/helpers';

const views: ChatFeatureView[] = [
    { id: 'agentic.feature.git', name: 'Git', ui: { section: { label: 'Code', icon: 'code' }, chatRefPrefixes: ['pr:'] } },
    { id: 'agentic.feature.plan', name: 'Plan', ui: { section: { label: 'Plan', icon: 'menu' }, chatRefPrefixes: ['#'] } },
    { id: 'x.notes', name: 'Notes', ui: {} }
];

const item = (id: number, title: string, state: PlanItem['state'] = 'ready'): PlanItem => ({ id, title, state, after: [], touches: [], refs: [], doneWhen: [], activity: [] });
const pull = (number: number, title: string, state: PullRequest['state'] = 'open'): PullRequest => ({ number, title, state } as PullRequest);

const agents: AgentIdentity[] = [
    { id: 'atlas', name: 'Atlas', role: 'coordinator', hue: 1 },
    { id: 'forge', name: 'Forge', role: 'engineer', hue: 2 },
    { id: 'nova', name: 'Nova', role: 'manager', hue: 3 }
] as AgentIdentity[];
const lookup = lookupOver(Object.fromEntries(agents.map((a) => [a.id, a])));
const members: MockChatMember[] = [
    { agentId: 'atlas', status: 'idle', history: { access: 'all' }, coordinator: true },
    { agentId: 'forge', status: 'idle', history: { access: 'all' } }
] as MockChatMember[];
const nova: Visitor = { agentId: 'nova' as AgentId, projectId: 'p_signalx' as ProjectId, projectName: 'SignalX', role: VISITING_ROLE };

describe('context chips', () => {
    it('one per enabled feature that adds a prefix, in the project order, named by its section', () => {
        const chips = contextChips(['agentic.feature.plan', 'x.notes', 'agentic.feature.git', 'x.unknown'], views);
        expect(chips).toEqual([
            { featureId: 'agentic.feature.plan', label: 'Plan', prefixes: ['#'] },
            { featureId: 'agentic.feature.git', label: 'Code', prefixes: ['pr:'] }
        ]);
        expect(chipPrefixes(chips)).toEqual(['#', 'pr:']);
        expect(contextChips([], views)).toEqual([]);
    });

    it('renders the chips and puts a prefix into the composer on a press', async () => {
        const inserted: string[] = [];
        const root = await mountAt('/chats/c1', <ContextChips chips={contextChips(['agentic.feature.plan', 'agentic.feature.git'], views)} onInsert={(p: string) => inserted.push(p)} />);
        const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-context-chip]')];
        expect(chips.map(text)).toEqual(['Plan #', 'Code pr:']);
        chips[1]!.click();
        expect(inserted).toEqual(['pr:']);
    });

    it('renders nothing without a chip', async () => {
        const root = await mountAt('/chats/c1', <ContextChips chips={[]} />);
        expect(root.querySelector('[data-context-chips]')).toBeNull();
    });
});

describe('chatRefSources', () => {
    const items = [item(9, 'Fix batch()', 'done'), item(16, 'Bump SignalX')];
    const pulls = [pull(88, 'batch() fix', 'merged'), pull(604, 'Rings v2')];

    it('lists the plan items under # and the pull requests under pr:, open first', () => {
        expect(chatRefSources(['#', 'pr:'], items, pulls)).toEqual([
            { prefix: '#', items: [{ id: '16', label: 'Bump SignalX' }, { id: '9', label: 'Fix batch()' }] },
            { prefix: 'pr:', items: [{ id: '604', label: 'Rings v2' }, { id: '88', label: 'batch() fix' }] }
        ]);
    });

    it('lists only the prefixes the project enables', () => {
        expect(chatRefSources(['#'], items, pulls).map((s) => s.prefix)).toEqual(['#']);
        expect(chatRefSources([], items, pulls)).toEqual([]);
    });
});

describe('chatAddressing', () => {
    it('without a mention: the coordinator, and the hint to bring another project in', () => {
        const a = chatAddressing(members, 'hello', [nova], lookup);
        expect(a.recipients.map((r) => r.name)).toEqual(['Atlas']);
        expect(a.hint).toBe(BRING_IN_HINT);
    });

    it('a visitor not yet in the chat shows in To with its project chip', () => {
        const a = chatAddressing(members, '@Nova can you triage this?', [nova], lookup);
        expect(a.recipients).toEqual([expect.objectContaining({ id: 'nova', name: 'Nova', project: 'SignalX' })]);
        expect(a.hint).toBe('Nova will answer');
    });

    it('a member and a visitor mentioned together both show, only the visitor with a project', () => {
        const a = chatAddressing(members, '@Forge @Nova', [nova], lookup);
        expect(a.recipients.map((r) => [r.name, r.project])).toEqual([['Forge', undefined], ['Nova', 'SignalX']]);
    });

    it('a visitor already a member keeps its project chip; no one left to bring in, no hint', () => {
        const withNova = [...members, { agentId: 'nova', status: 'idle', history: { access: 'all' } } as MockChatMember];
        const a = chatAddressing(withNova, '@Nova', [nova], lookup);
        expect(a.recipients.map((r) => r.project)).toEqual(['SignalX']);
        expect(chatAddressing(withNova, 'hi', [nova], lookup).hint).toBe('Atlas answers unless you @ someone');
    });

    it('outside a project there is no one to bring in', () => {
        expect(chatAddressing(members, '@Nova', [], lookup).recipients.map((r) => r.name)).toEqual(['Atlas']);
    });
});
