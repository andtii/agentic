/**
 * Setting a machine up on mock data (#239, #482, `pnpm dev:mock`): alien01's
 * daemon lets the page manage environments inside folders set from the web,
 * nuc-lab's predates web-set folders and has none allowed — both states,
 * the folders card and its previews, the setup checklist, Restart… and the
 * daemon log, walked through without a machine.
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

    it('alien01: the folders card lists the roots as asked beside what they became; a preview walks the other states; a save applies', async () => {
        const root = await mountAt('/machines/alien01', <Machine />);
        const card = () => root.querySelector<HTMLElement>('[data-policy-card]')!;
        const rows = () => [...card().querySelectorAll('[data-policy-root]')].map((r) => r.getAttribute('data-policy-root'));
        expect(card().getAttribute('data-policy-state')).toBe('web');
        expect(rows()).toEqual(['C:\\Dev', 'D:\\scratch', '~/src', 'C:\\clients']);
        expect(text([...card().querySelectorAll('[data-policy-root]')].find((r) => r.getAttribute('data-policy-root') === '~/src')?.querySelector('[data-policy-resolved]'))).toBe('→ C:\\Users\\andy\\src');
        expect(root.querySelector('[data-setup-checklist]')!.getAttribute('data-setup-current')).toBe('ready'); // client-acme's doctor check fails

        // Browse the sample tree: roots → a drive → a folder; Allow adds it.
        button(card(), 'Browse…').click();
        await tick();
        expect(text(open().querySelector('[data-part="title"]'))).toContain('Choose a folder on alien01');
        [...open().querySelectorAll<HTMLButtonElement>('[data-part="shortcut"]')].find((b) => b.textContent?.includes('D:\\'))!.click();
        await tick();
        expect([...open().querySelectorAll('[data-part="item"] [data-part="name"]')].map((e) => text(e))).toEqual(['scratch', 'backups']);
        open().querySelectorAll<HTMLElement>('[data-part="item"]')[1]!.click();
        await tick();
        expect([...open().querySelectorAll('[data-part="crumb"]')].map((e) => text(e))).toEqual(['alien01', 'D:\\', 'backups']);
        button(open(), 'Allow this folder').click();
        await tick();
        expect(rows()).toEqual(['C:\\Dev', 'D:\\scratch', '~/src', 'C:\\clients', 'D:\\backups']);
        expect(card().hasAttribute('data-dirty')).toBe(true);
        button(card(), 'Save folders').click();
        await new Promise((r) => setTimeout(r, 450));
        await tick();
        expect(text(card().querySelector('[data-policy-notice]'))).toBe('Applied on the machine.');
        expect(card().hasAttribute('data-dirty')).toBe(false);
        expect(text([...card().querySelectorAll('[data-policy-root]')].find((r) => r.getAttribute('data-policy-root') === 'D:\\backups')?.querySelector('[data-policy-resolved]'))).toBe('');

        // The preview picker: locked is read-only with the unlock command; the page's own policy follows.
        const preview = card().querySelector<HTMLSelectElement>('select[name="policy-preview"]')!;
        preview.value = 'locked';
        preview.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(card().getAttribute('data-policy-state')).toBe('locked');
        expect(text(card().querySelector('[data-command-well] code'))).toBe('agentic-daemon policy unlock');
        expect(card().querySelector('input[name="policy-root"]')).toBeNull();
        preview.value = 'no-feature';
        preview.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(card().getAttribute('data-policy-state')).toBe('no-feature');
        expect(root.querySelector('[data-env-policy]')!.getAttribute('data-env-policy')).toBe('off');
        expect([...root.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Add environment' && !b.closest('[data-part="popup"]'))).toBe(false);
        expect(root.querySelector('[data-setup-checklist]')!.getAttribute('data-setup-current')).toBe('folders');
    });

    it('alien01: Restart… confirms with the running turn and a drain/now choice; the daemon log shows the sample lines', async () => {
        const root = await mountAt('/machines/alien01', <Machine />);
        button(root, 'Restart…').click();
        await tick();
        expect(text(open())).toContain('Restart the daemon on alien01?');
        // A consequence confirm (it interrupts running turns): the alert dialog, not a form.
        expect(open().getAttribute('role')).toBe('alertdialog');
        expect(text(open())).toContain('1 running turn will be interrupted and offered Resume.');
        expect(text(open().querySelector('[data-update-turns]'))).toContain('Lint · s_41ab');
        button(open(), 'Restart').click();
        await tick();
        expect(text(root.querySelector('[data-machine-restart]'))).toContain('Restarting when idle');
        expect(button(root, 'Restart…').disabled).toBe(true);

        const details = root.querySelector<HTMLDetailsElement>('[data-daemon-log]')!;
        details.querySelector<HTMLElement>('summary')!.click();
        await tick();
        expect(text(details)).toContain('Reading…');
        await new Promise((r) => setTimeout(r, 350));
        await tick();
        expect(details.querySelector('[data-daemon-log-lines]')!.textContent).toContain('"msg":"daemon: started"');
        expect(details.querySelector('[data-daemon-log-lines]')!.textContent).not.toMatch(/amt\./);
        expect(text(details)).toContain('the file holds more');
    });

    it('nuc-lab: offline, the checklist waits for the daemon and the log says the machine is offline', async () => {
        const root = await mountAt('/machines/nuc-lab', <Machine />);
        expect(root.querySelector('[data-setup-checklist]')!.getAttribute('data-setup-current')).toBe('paired');
        expect(text(root.querySelector('[data-setup-step="paired"]'))).toContain('Waiting for the daemon to connect');
        // A daemon without the features: no Restart…, no log.
        expect([...root.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Restart…')).toBe(false);
        expect(root.querySelector('[data-daemon-log]')).toBeNull();
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
        // Rename is data entry: a FormDialog (a plain dialog around a form).
        expect(open().getAttribute('role')).not.toBe('alertdialog');
        expect(open().querySelector('form[data-form-dialog] input[name="machine-name"]')).not.toBeNull();
        setText(open().querySelector<HTMLInputElement>('input[name="machine-name"]')!, 'workstation');
        button(open(), 'Rename').click();
        await tick();
        expect(text(root.querySelector('[data-machine-hero] [data-machine-name]'))).toBe('workstation');
    });
});
