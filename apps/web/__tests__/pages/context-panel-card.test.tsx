/**
 * The member card: one bordered group of rows — where it runs, the folder
 * (the only row that switches, with its source named), the model when the
 * config names one — the account's usage as one line with "Limit reached ·
 * resets …" under it once the account is out, and the footer with history
 * access beside "New session".
 */
import { describe, it, expect } from 'vitest';
import type { EnvironmentId, QuotaSnapshot } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { ContextPanel } from '../../src/pages/chat/ContextPanel';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatSummary } from '../../src/mock/workspace';
import { mountAt } from './helpers';

const ENV = 'env_alien01_work' as EnvironmentId;
const atlas: AgentIdentity = { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };
const forge: AgentIdentity = { id: 'forge', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, environmentId: ENV, model: 'claude-sonnet-4.5', configVersion: 1 };
const lookup = lookupOver({ atlas, forge });

const exhausted: QuotaSnapshot = {
    sourceId: 'agentic.quota.claude-code',
    runtime: 'claude-code',
    environmentId: ENV,
    availability: 'reported',
    windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 1, unit: 'percent', resetsAt: new Date(Date.now() + 36 * 3_600_000).toISOString(), status: 'exhausted' }],
    observedAt: Date.now(),
    via: 'probe'
};
const environments: readonly WorkdirEnvironment[] = [{ id: ENV, label: 'alien01 / work', os: 'windows', roots: ['C:\\Dev'], quota: exhausted }];

const chat: MockChatSummary = {
    id: 'c1',
    title: 'Atlas, Forge',
    members: [
        { agentId: 'atlas', status: 'idle', coordinator: true, history: { access: 'all' } },
        { agentId: 'forge', status: 'idle', history: { access: 'all' }, workdir: { environmentId: ENV, path: 'C:\\Dev\\agentic\\main' } }
    ],
    lastLine: '',
    unread: 0,
    waiting: false,
    updatedAt: 0
};

const texts = (nodes: Iterable<Element>): string[] => [...nodes].map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '');

describe('ContextPanel — the member card', () => {
    it('lays each member out as head, rows, usage and footer; only the folder row is a button', async () => {
        const root = await mountAt('/chats/c1', <ContextPanel chat={chat} tasks={[]} lookup={lookup} environments={environments} project={{ folders: {} }} />);
        const cards = [...root.querySelectorAll('[data-member]')];
        expect(cards).toHaveLength(2);
        expect(cards.map((c) => c.querySelector('[data-member-head] [data-member-name]')?.textContent)).toEqual(['Atlas', 'Forge']);
        // A platform agent: where it runs, no folder, no model; its usage note; the footer.
        expect(texts(cards[0]!.querySelectorAll('[data-member-row]'))).toEqual(['platform/anthropic-api/byo-key']);
        expect(cards[0]!.querySelector('[data-member-quota]')!.textContent).toContain('No plan limits · API key');
        expect(cards[0]!.querySelector('[data-member-limit]')).toBeNull();
        expect(texts(cards[0]!.querySelectorAll('[data-member-foot] > *'))).toEqual(['Coordinator · sees all history', 'New session']);
        // A daemon agent with its own folder for this chat and a model in its config.
        const rows = [...cards[1]!.querySelectorAll('[data-member-row]')];
        expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(['environment', 'folder', 'model']);
        expect(rows.map((r) => r.querySelector('button') !== null)).toEqual([false, true, false]);
        const open = rows[1]!.querySelector<HTMLButtonElement>('[data-member-workdir-open]')!;
        expect(open.querySelector('[data-member-workdir-from]')!.textContent).toBe('this chat');
        expect(open.querySelector('[data-member-workdir-path]')!.textContent).toBe('…\\agentic\\main');
        expect(open.getAttribute('title')).toBe('alien01 / work · …\\agentic\\main');
        expect(rows[1]!.querySelector('[data-member-workdir-clear]')).not.toBeNull();
        expect(rows[2]!.querySelector('[data-member-model]')!.textContent).toBe('claude-sonnet-4.5');
    });

    it('says when the account is out and when it resets, under the usage line', async () => {
        const root = await mountAt('/chats/c1', <ContextPanel chat={chat} tasks={[]} lookup={lookup} environments={environments} project={{ folders: {} }} />);
        const forgeCard = root.querySelectorAll('[data-member]')[1]!;
        expect(forgeCard.querySelector('[data-member-quota]')!.hasAttribute('data-limit')).toBe(true);
        expect(forgeCard.querySelector('[data-member-limit]')!.textContent).toMatch(/^Limit reached · resets /);
    });
});
