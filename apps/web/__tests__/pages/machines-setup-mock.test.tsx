/**
 * Setting a machine up on mock data (#239, `pnpm dev:mock`): alien01's
 * daemon lets the page manage environments inside its allowed folders,
 * nuc-lab's does not — both states, walked through without a machine.
 */
import { describe, it, expect } from 'vitest';
import { Machine } from '../../src/pages/Machine';
import { mountAt, setText, text, tick } from './helpers';

const open = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
/** A button by its text, never one inside a closed dialog. */
const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root === open() || !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const cardNames = (root: ParentNode): string[] => [...root.querySelectorAll('[data-scope="ag-env-card"][data-part="root"]')].map((c) => c.getAttribute('aria-label') ?? '');

describe('/machines/:id on mock data (#239)', () => {
    it('nuc-lab keeps web management off: the local command, no Add, no Edit', async () => {
        const root = await mountAt('/machines/nuc-lab', <Machine />);
        expect(root.querySelector('[data-env-policy]')!.getAttribute('data-env-policy')).toBe('off');
        expect(text(root.querySelector('[data-env-policy] [data-command-well] code'))).toBe('agentic-daemon policy allow-root C:\\work');
        // The command is not on PATH on a machine installed before #354: the long form is one disclosure away.
        expect(text(root.querySelector('[data-env-policy] [data-command-fallback] [data-command-well] code'))).toBe(
            'node "$env:LOCALAPPDATA\\agentic\\daemon\\bin\\agentic-daemon.mjs" policy allow-root C:\\work'
        );
        expect(root.querySelector('[data-env-actions]')).toBeNull();
        expect([...root.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Add environment')).toBe(false);
    });

    it('alien01: the expired account shows its sign-in command; a new environment lands signed-out with one', async () => {
        const root = await mountAt('/machines/alien01', <Machine />);
        expect(root.querySelector('[data-env-policy]')).toBeNull();
        expect(text(root.querySelector('[data-env-cell][data-environment="env_alien01_client_acme"] [data-env-login] code'))).toBe('agentic-daemon env login env_alien01_client_acme');

        button(root, 'Add environment').click();
        await tick();
        setText(open().querySelector<HTMLInputElement>('input[name="env-name"]')!, 'lab');
        // One click puts an allowed folder in.
        button(open(), 'D:\\scratch').click();
        await tick();
        expect(open().querySelector<HTMLTextAreaElement>('textarea[name="env-roots"]')!.value).toBe('D:\\scratch');
        button(open(), 'Add environment').click();
        await tick();
        await tick();
        expect(open()).toBeNull();
        expect(cardNames(root)).toEqual(['work', 'personal', 'client-acme', 'copilot', 'codex', 'lab']);
        expect(text(root.querySelector('[data-env-cell][data-environment="env_alien01_lab"] [data-env-login] code'))).toBe('agentic-daemon env login env_alien01_lab');
    });

    it('alien01: removing an environment with work in it is refused and explained; rename changes the hero', async () => {
        const root = await mountAt('/machines/alien01', <Machine />);
        button(root.querySelector('[data-env-cell][data-environment="env_alien01_work"]')!, 'Remove').click();
        await tick();
        expect(text(open().querySelector('[data-confirm-dependents]'))).toContain('s_41aa · Drawer collapse in shell.css');
        button(open(), 'Remove work').click();
        await tick();
        expect(text(open().querySelector('[data-env-failure]'))).toBe('Work is running or queued in this environment. Let it finish or cancel it, then remove the environment.');
        expect(cardNames(root)).toContain('work');
        button(open(), 'Keep it').click();
        await tick();

        button(root, 'Rename').click();
        await tick();
        setText(open().querySelector<HTMLInputElement>('input[name="machine-name"]')!, 'workstation');
        button(open(), 'Rename').click();
        await tick();
        expect(text(root.querySelector('[data-machine-hero] [data-machine-name]'))).toBe('workstation');
    });
});
