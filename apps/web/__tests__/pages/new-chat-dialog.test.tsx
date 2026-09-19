/**
 * New chat (#315): the agents as cards — where each runs and how much of its account's plan is left — picked like
 * checkboxes, with the coordinator a radio on the picked cards once there is a group; none picked keeps it open.
 */
import { describe, it, expect } from 'vitest';
import { signal } from 'sigx';
import type { EnvironmentId, QuotaSnapshot } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import { NewChatDialog } from '../../src/pages/chat/NewChatDialog';
import type { AgentIdentity } from '../../src/pages/chat/live';
import { mountAt, tick } from './helpers';

const WORK = 'env_alien01_work' as EnvironmentId;
const quota = (utilization: number): QuotaSnapshot => ({ sourceId: 'q', runtime: 'claude-code', environmentId: WORK, availability: 'reported', windows: [{ id: 'seven_day', label: 'Current week (all models)', period: 'week', utilization, unit: 'percent', status: utilization >= 0.8 ? 'warning' : 'ok' }], observedAt: Date.now(), via: 'probe' });
const environments: WorkdirEnvironment[] = [{ id: WORK, label: 'alien01 / work', os: 'windows', roots: ['C:\\Dev'], quota: quota(0.76) }];
const agents: AgentIdentity[] = [
    { id: 'forge', name: 'Forge', role: 'Developer', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, environmentId: WORK, configVersion: 1 },
    { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 },
    { id: 'lint', name: 'Lint', role: 'Reviewer', hue: 3, environment: { machine: 'unassigned', runtime: 'claude-code', account: 'machine' }, configVersion: 1 }
];

async function open() {
    const created: { agentIds: readonly string[]; coordinator: string | null }[] = [];
    const model = signal({ value: true });
    const root = await mountAt('/chats', <NewChatDialog model={() => model.value} agents={agents} environments={environments} onCreate={(e) => created.push(e)} />);
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-new-chat-agent="${id}"]`)!;
    const pick = async (id: string) => {
        const box = card(id).querySelector<HTMLInputElement>('input[name="member"]')!;
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
    };
    const create = async () => {
        [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith('Create chat'))!.click();
        await tick();
    };
    return { root, created, card, pick, create };
}

describe('New chat (#315)', () => {
    it('shows each agent where it runs and its account\u2019s limits', async () => {
        const { card } = await open();
        expect(card('forge').querySelector('[data-scope="ag-env-line"]')).not.toBeNull();
        expect(card('forge').querySelector('[data-new-chat-quota] [data-scope="ag-quota"][data-part="used"]')!.textContent).toBe('76% used');
        expect(card('atlas').querySelector('[data-new-chat-quota]')!.textContent).toBe('No plan limits · API key');
        expect(card('lint').querySelector('[data-new-chat-quota]')!.textContent).toBe('No environment chosen');
    });

    it('refuses to create with nobody picked, then offers the coordinator on picked cards of a group', async () => {
        const { card, pick, create, created } = await open();
        await create();
        expect(created).toEqual([]);
        expect(document.querySelector('[data-new-chat-required]')!.textContent).toBe('Pick at least one agent.');
        await pick('forge');
        expect(card('forge').hasAttribute('data-picked')).toBe(true);
        expect(card('forge').querySelector('input[name="coordinator"]')).toBeNull();
        await pick('atlas');
        const radio = card('atlas').querySelector<HTMLInputElement>('input[name="coordinator"]')!;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(document.querySelector('[data-new-chat-summary]')!.textContent).toContain('Atlas answers unless you mention someone');
        await create();
        expect(created).toEqual([{ agentIds: ['forge', 'atlas'], coordinator: 'atlas' }]);
    });
});
