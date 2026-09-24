/**
 * "Start task" (#193) on the kit `FormDialog` (#594): a real form — submit
 * validates the agent and the objective and keeps the dialog open, a valid
 * submit emits the input, a start that failed is an `ErrorNote`, and
 * Cancel says so.
 */
import { describe, it, expect } from 'vitest';
import { signal } from 'sigx';
import type { AgentIdentity } from '../../src/pages/chat/live';
import type { StartTaskInput } from '../../src/pages/task/start';
import type { WorkdirEnvironments } from '../../src/pages/workdir/environments';
import { StartTaskDialog } from '../../src/pages/task/StartTaskDialog';
import { mountAt, setText, text, tick } from './helpers';

const atlas: AgentIdentity = { id: 'atlas', name: 'Atlas', role: 'Assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 };

const workdirs: WorkdirEnvironments = {
    list: () => [],
    machineOf: () => undefined,
    machines: () => [],
    accounts: () => [],
    hosted: () => false,
    accountEnvironment: () => undefined,
    lastMachineId: () => null,
    loading: false
};

async function mountDialog(error = '') {
    const st = signal({ open: false, error });
    const started: StartTaskInput[] = [];
    let cancelled = 0;
    await mountAt('/', (
        <StartTaskDialog
            model={() => st.open}
            agents={[atlas]}
            workdirs={workdirs}
            error={st.error}
            onStart={(input) => { started.push(input); }}
            onCancel={() => { cancelled += 1; }}
        />
    ));
    st.open = true;
    await tick();
    const form = document.querySelector<HTMLFormElement>('[data-form-dialog]')!;
    return { st, form, started, cancelled: () => cancelled };
}

const submit = async (form: HTMLFormElement): Promise<void> => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
};

describe('Start task dialog (FormDialog)', () => {
    it('is a form in a plain dialog: submit validates and stays open, a valid submit emits the input', async () => {
        const { form, started } = await mountDialog();
        expect(form).not.toBeNull();
        expect(form.closest('dialog, [role="dialog"]')).not.toBeNull();
        expect(form.closest('[role="alertdialog"]')).toBeNull();
        expect(text(form.querySelector('[data-scope="dialog"][data-part="title"]'))).toBe('Start task');
        expect(text(form.querySelector('button[type="submit"]'))).toBe('Start task');

        await submit(form);
        expect(started).toEqual([]);
        expect(text(form)).toContain('Pick the agent that does it.');
        expect(text(form)).toContain('Say what it should do.');
        expect(document.querySelector('[data-form-dialog]')).toBe(form);

        form.querySelector<HTMLElement>('[data-scope="select"][data-part="trigger"]')!.click();
        await tick();
        [...form.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => text(o).startsWith('Atlas'))!.click();
        await tick();
        setText(form.querySelector('textarea')!, 'Tidy the changelog');
        await tick();
        expect(text(form.querySelector('[data-start-task-note]'))).toBe('Atlas runs on the platform: no machine, no folder.');

        await submit(form);
        expect(started).toEqual([{ agentId: 'atlas', objective: 'Tidy the changelog', workdir: null }]);
    });

    it('a failed start is an ErrorNote under the fields, keeping its hook', async () => {
        const { form } = await mountDialog('router refused');
        const note = form.querySelector('[data-start-task-error]')!;
        expect(note.getAttribute('role')).toBe('alert');
        expect(note.getAttribute('data-scope')).toBe('alert');
        expect(text(note)).toBe('router refused');
        expect(form.querySelector('p[role="alert"]')).toBeNull();
    });

    it('Cancel emits cancel', async () => {
        const { form, cancelled } = await mountDialog();
        [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === 'Cancel')!.click();
        await tick();
        expect(cancelled()).toBe(1);
    });
});
