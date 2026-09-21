/**
 * "New session" on a chat member (#399): the context panel offers it beside
 * the member's other controls, asks first — saying the agent forgets this
 * conversation and the chat's history stays — and emits `resetSession` only
 * on the confirmation. Mounted at a phone's width: the panel is the drawer's
 * content there, and the dialog is the same one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ContextPanel } from '../../src/pages/chat/ContextPanel';
import { lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import type { MockChatSummary } from '../../src/mock/workspace';
import { mountAt, tick } from './helpers';

const atlas: AgentIdentity = { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };
const forge: AgentIdentity = { id: 'forge', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
const lookup = lookupOver({ atlas, forge });
const chat: MockChatSummary = {
    id: 'c1',
    title: 'Atlas, Forge',
    members: [
        { agentId: 'atlas', status: 'active', coordinator: true, history: { access: 'all' } },
        { agentId: 'forge', status: 'idle', history: { access: 'from', at: 1_700_000_000_000 } }
    ],
    lastLine: '',
    unread: 0,
    waiting: false,
    updatedAt: 0
};

const PHONE = 375;
const originalWidth = window.innerWidth;
afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true });
});

/** The open dialog — every ConfirmDialog of the panel is in the DOM closed from the start (signalxjs/zero#102). */
const dialog = (): HTMLElement | null => [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((d) => d.open || d.hasAttribute('open') || d.getAttribute('data-state') === 'open') ?? null;
/** The dialog's own confirm button — not a member's "New session" in the panel. */
const confirm = (): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'New session' && !b.hasAttribute('data-member-reset'))!;
const cancel = (): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Cancel')!;

describe('ContextPanel — New session (#399)', () => {
    it('offers New session on every member at a phone’s width, asks what is lost, and emits only on the confirmation', async () => {
        Object.defineProperty(window, 'innerWidth', { value: PHONE, configurable: true, writable: true });
        const events: { agentId: string }[] = [];
        const root = await mountAt('/chats/c1', <ContextPanel chat={chat} tasks={[]} lookup={lookup} onResetSession={(e) => events.push(e)} />);

        const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-member] [data-member-reset]')];
        expect(buttons.map((b) => b.textContent?.trim())).toEqual(['New session', 'New session']);
        expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['New session for Atlas', 'New session for Forge']);
        expect(dialog()).toBeNull();

        // Asked first, in the member's name, with what is lost and what stays.
        buttons[1]!.click();
        await tick();
        expect(dialog()).not.toBeNull();
        expect(dialog()!.textContent).toContain('Start a new session for Forge?');
        expect(dialog()!.textContent).toContain('Forge forgets this conversation');
        expect(dialog()!.textContent).toContain("The chat's history stays");
        expect(events).toEqual([]);

        // Cancelled: nothing happens.
        cancel().click();
        await tick();
        expect(events).toEqual([]);
        await tick();

        // Confirmed for the other member: one event, naming it.
        buttons[0]!.click();
        await tick();
        expect(dialog()!.textContent).toContain('Start a new session for Atlas?');
        confirm().click();
        await tick();
        expect(events).toEqual([{ agentId: 'atlas' }]);
        // The dialog is a modal over the page, never wider than the viewport it opened in.
        expect(window.innerWidth).toBe(PHONE);
    });
});
