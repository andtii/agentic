/**
 * The member card: one bordered group of rows — where it runs, the folder
 * (the only row that switches, with its source named), the model when the
 * config names one — the usage as rings for the windows that limit the
 * member's model, "<Fable> limit · resets …" under them once one is out,
 * "Details" opening the account's whole panel (#452), and the footer with
 * history access beside "New session".
 */
import { describe, it, expect } from 'vitest';
import type { EnvironmentId, QuotaSnapshot } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { ContextPanel } from '../../src/pages/chat/ContextPanel';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatSummary } from '../../src/mock/workspace';
import { mountAt, tick } from './helpers';

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

    it('says which limit is out and when it resets, under the rings', async () => {
        const root = await mountAt('/chats/c1', <ContextPanel chat={chat} tasks={[]} lookup={lookup} environments={environments} project={{ folders: {} }} />);
        const forgeCard = root.querySelectorAll('[data-member]')[1]!;
        expect(forgeCard.querySelector('[data-member-usage]')!.hasAttribute('data-limit')).toBe(true);
        expect(forgeCard.querySelector('[data-member-quota] [role="progressbar"]')!.getAttribute('aria-label')).toBe('Week');
        expect(forgeCard.querySelector('[data-member-limit]')!.textContent).toMatch(/^Weekly limit · resets \w{3} \d{2}:\d{2}$/);
    });

    it('says so even when the exhausted window carries no number (Claude Code’s limit message)', async () => {
        // Only the status says the account is out: `tightestWindow` skips it, the line must not.
        const noNumber: QuotaSnapshot = { ...exhausted, windows: [{ ...exhausted.windows[0]!, utilization: null, resetsAt: undefined }] };
        const envs: readonly WorkdirEnvironment[] = [{ ...environments[0]!, quota: noNumber }];
        const root = await mountAt('/chats/c1', <ContextPanel chat={chat} tasks={[]} lookup={lookup} environments={envs} project={{ folders: {} }} />);
        expect(root.querySelectorAll('[data-member]')[1]!.querySelector('[data-member-limit]')!.textContent).toBe('Weekly limit reached');
    });
});

describe('ContextPanel — usage for the member’s model (#452)', () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const account: QuotaSnapshot = {
        ...exhausted,
        plan: 'max',
        windows: [
            { id: 'five_hour', label: 'Current session', period: 'session', utilization: 0.12, unit: 'percent', resetsAt: inHours(3), status: 'ok' },
            { id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization: 0.77, unit: 'percent', resetsAt: inHours(80), status: 'ok' },
            { id: 'seven_day:fable', label: 'Current week (Fable)', period: 'week', scope: { model: 'Fable' }, utilization: 1, unit: 'percent', resetsAt: inHours(80), status: 'exhausted' },
            { id: 'extra_usage', label: 'Extra usage', period: 'month', utilization: 0.2, unit: 'usd', status: 'ok' }
        ]
    };
    const envs: readonly WorkdirEnvironment[] = [{ ...environments[0]!, quota: account }];
    const card = async (model: string) => {
        const agent: AgentIdentity = { ...forge, model };
        const root = await mountAt('/chats/c1', <ContextPanel chat={{ ...chat, members: [chat.members[1]!] }} tasks={[]} lookup={lookupOver({ forge: agent })} environments={envs} project={{ folders: {} }} />);
        return root.querySelector('[data-member]')!;
    };
    const rings = (c: Element) => [...c.querySelectorAll('[data-member-quota] [role="progressbar"]')].map((r) => `${r.getAttribute('aria-valuenow')}% ${r.getAttribute('aria-label')}:${r.getAttribute('data-status')}`);

    it('a Sonnet member does not wear the Fable week: no Fable ring, no limit line', async () => {
        const c = await card('claude-sonnet-5');
        expect(rings(c)).toEqual(['12% Session:ok', '77% Week:ok']);
        expect(c.querySelector('[data-member-limit]')).toBeNull();
        expect(c.querySelector('[data-member-usage]')!.hasAttribute('data-limit')).toBe(false);
    });

    it('a Fable member: the Fable ring is out, and the line names it', async () => {
        const c = await card('claude-fable-5-1');
        expect(rings(c)).toEqual(['12% Session:ok', '77% Week:ok', '100% Fable:exhausted']);
        expect(c.querySelector('[data-member-limit]')!.textContent).toMatch(/^Fable limit · resets \w{3} \d{2}:\d{2}$/);
        expect(c.querySelector('[data-member-usage]')!.hasAttribute('data-limit')).toBe(true);
    });

    it('its override for this chat wins over its config’s model', async () => {
        const agent: AgentIdentity = { ...forge, model: 'claude-sonnet-5' };
        const root = await mountAt('/chats/c1', <ContextPanel chat={{ ...chat, members: [{ ...chat.members[1]!, options: { model: 'claude-fable-5-1' } }] }} tasks={[]} lookup={lookupOver({ forge: agent })} environments={envs} project={{ folders: {} }} />);
        expect(rings(root.querySelector('[data-member]')!)).toEqual(['12% Session:ok', '77% Week:ok', '100% Fable:exhausted']);
    });

    it('Details opens the account’s whole panel — every window, the zone in its header — and closes it again', async () => {
        const c = await card('claude-sonnet-5');
        const toggle = c.querySelector<HTMLButtonElement>('[data-member-details-toggle]')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(c.querySelector('[data-member-details]')).toBeNull();
        toggle.click();
        await tick();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const panel = c.querySelector('[data-member-details] [data-scope="ag-quota-panel"][data-part="root"]')!;
        expect([...panel.querySelectorAll('[data-scope="ag-quota"][data-part="label"]')].map((l) => l.textContent)).toEqual(['Current session', 'Current week (all models)', 'Current week (Fable)', 'Extra usage']);
        expect(panel.querySelector('[data-scope="ag-quota-panel"][data-part="zone"]')!.textContent).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(panel.querySelector('[data-window="seven_day:fable"] [data-part="resets"]')!.textContent).toMatch(/^Resets \w{3} \d{1,2} \w{3} \d{2}:\d{2}$/);
        toggle.click();
        await tick();
        expect(c.querySelector('[data-member-details]')).toBeNull();
    });
});
