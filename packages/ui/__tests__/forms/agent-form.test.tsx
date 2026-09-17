import { signal } from '@sigx/reactivity';
import type { AgentConfig } from '@agentic/core';
import { AgentForm, AGENT_FIELDS as F, agentDraftFromFormData, fromAgentDraft, toAgentDraft, type AgentErrors, type AgentFormApi } from '@agentic/ui';
import { controls, describedByRole, fullAgentConfig, labelOf, mount, setSelect, setText, submit, toggle } from './helpers';

function mountForm(config: AgentConfig = fullAgentConfig()) {
    const state = signal({ config });
    const ref = { current: null as AgentFormApi | null };
    const submitted: { config: AgentConfig; reason: string }[] = [];
    const invalid: AgentErrors[] = [];
    const root = mount(
        <AgentForm
            model={() => state.config}
            ref={ref}
            skills={[{ value: 'review', label: 'Review' }, { value: 'triage', label: 'Triage' }]}
            tools={[{ value: 'Read' }, { value: 'Bash' }, { value: 'Delete' }, { value: 'Write' }]}
            environments={[{ value: 'env_1', label: 'Laptop' }]}
            agents={[{ value: 'agent_a', label: 'A' }, { value: 'agent_b', label: 'B' }, { value: 'agent_c', label: 'C' }]}
            onSubmit={(d) => submitted.push(d)}
            onInvalid={(e) => invalid.push(e)}
        />
    );
    const form = root.querySelector('form')!;
    const api = () => ref.current!;
    return { state, root, form, api, submitted, invalid };
}

describe('AgentForm', () => {
    it('gives every control a label and no dangling error', () => {
        const { root } = mountForm();
        const all = controls(root);
        expect(all.length).toBeGreaterThan(20);
        for (const el of all) expect(labelOf(el), `${el.tagName} name=${el.getAttribute('name')} has a label`).not.toBe('');
        expect(root.querySelectorAll('[data-scope="field"][data-part="error"]').length).toBe(0);
    });

    it('posts a FormData that reads back to the bound config', () => {
        const { form, state } = mountForm();
        const posted = fromAgentDraft(agentDraftFromFormData(new FormData(form)));
        expect(posted).toEqual(state.config);
    });

    it('binds edits through the model and writes the config back on submit', () => {
        const { form, root, state, api, submitted } = mountForm();
        setText(root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!, 'Reviewer 2');
        setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.offlinePolicy}"]`)!, 'queue');
        setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.approval('read')}"]`)!, 'allow');
        setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.toolMode('Bash')}"]`)!, 'deny');
        toggle(root.querySelector<HTMLInputElement>(`input[name="${F.autoLearn}"]`)!, false);
        setText(root.querySelector<HTMLInputElement>(`input[name="${F.reason}"]`)!, 'because');
        expect(api().draft.name).toBe('Reviewer 2');
        expect(state.config.name).toBe('Reviewer'); // a draft until submitted

        submit(form);

        expect(submitted).toHaveLength(1);
        expect(submitted[0]!.reason).toBe('because');
        const next = state.config;
        expect(next.name).toBe('Reviewer 2');
        expect(next.execution.offlinePolicy).toBe('queue');
        expect(next.approvalPolicy[0]).toEqual({ id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' });
        expect(next.tools.find((t) => t.name === 'Bash')?.mode).toBe('deny');
        expect(next.memoryPolicy.autoLearn).toBe('off');
        // the posted form agrees with what was written back
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form)))).toEqual(next);
    });

    it('blocks submit while invalid and shows an accessible error on the field', () => {
        const { form, root, state, api, submitted, invalid } = mountForm();
        const name = root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!;
        setText(name, '   ');
        submit(form);

        expect(submitted).toHaveLength(0);
        expect(invalid).toHaveLength(1);
        expect(invalid[0]!.name).toMatch(/required/);
        expect(state.config.name).toBe('Reviewer');
        expect(api().submit()).toBe(false);

        expect(name.getAttribute('aria-invalid')).toBe('true');
        const errors = describedByRole(name, 'alert');
        expect(errors).toHaveLength(1);
        expect(errors[0]!.textContent).toMatch(/required/);
        expect(root.querySelector('[data-part="summary"]')?.textContent).toMatch(/needs attention/);

        // fixing the field clears the error and lets the submit through
        setText(name, 'Fixed');
        expect(name.getAttribute('aria-invalid')).not.toBe('true');
        expect(describedByRole(name, 'alert')).toHaveLength(0);
        submit(form);
        expect(submitted).toHaveLength(1);
        expect(state.config.name).toBe('Fixed');
    });

    it('the number fields clamp on blur, and a limit that still fails validation blocks submit with its error', () => {
        const { form, root, api, submitted } = mountForm();
        const turns = root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
        setText(turns, '0');
        turns.dispatchEvent(new Event('blur', { bubbles: true }));
        expect(api().draft.limits.maxTurns).toBe(1); // NumberInput clamps to min
        expect(new FormData(form).get(F.limit('maxTurns'))).toBe('1');

        api().draft.limits.maxTurns = 0; // e.g. a stale value from the server
        submit(form);
        expect(submitted).toHaveLength(0);
        expect(describedByRole(turns, 'alert')[0]?.textContent).toMatch(/at least 1/);
    });

    it('reset() restores the draft from the model and clears shown errors', () => {
        const { form, root, api, state } = mountForm();
        const name = root.querySelector<HTMLInputElement>(`input[name="${F.name}"]`)!;
        setText(name, '');
        toggle(root.querySelector<HTMLInputElement>(`input[name="${F.collaborateAll}"]`)!, true);
        submit(form);
        expect(describedByRole(name, 'alert')).toHaveLength(1);

        api().reset();

        expect(api().draft).toMatchObject(toAgentDraft(state.config));
        expect(name.value).toBe('Reviewer');
        expect(describedByRole(name, 'alert')).toHaveLength(0);
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form)))).toEqual(state.config);
    });

    it('collaborators are chosen only when delegation is not open to everyone', () => {
        const { root, form } = mountForm();
        expect(root.querySelectorAll(`input[name="${F.collaborators}"]`).length).toBe(2);
        toggle(root.querySelector<HTMLInputElement>(`input[name="${F.collaborateAll}"]`)!, true);
        expect(root.querySelectorAll(`input[name="${F.collaborators}"]`).length).toBe(0);
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form))).collaborators).toBe('all');
    });

    it('a tool picked from the list gets a mode select that posts', () => {
        const { root, form, api } = mountForm();
        const tools = root.querySelector<HTMLElement>(`[data-scope="ai-multi-select"]:has(input[name="${F.tools}"])`)!;
        const input = tools.querySelector<HTMLInputElement>('input[role="combobox"]')!;
        setText(input, 'Wri');
        tools.querySelector<HTMLElement>('[data-scope="combobox"][data-part="item"]')!.click();
        expect(api().draft.tools).toContain('Write');
        expect(api().draft.toolModes.Write).toBe('allow');
        const mode = root.querySelector<HTMLSelectElement>(`select[name="${F.toolMode('Write')}"]`)!;
        expect(labelOf(mode)).toMatch(/Write/);
        setSelect(mode, 'ask');
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form))).tools).toContainEqual({ name: 'Write', mode: 'ask' });
    });

    it('starts from the blank default without a model', () => {
        const root = mount(<AgentForm />);
        expect(root.querySelector<HTMLSelectElement>(`select[name="${F.runtime}"]`)!.value).toBe('anthropic-api');
        expect(root.querySelector<HTMLInputElement>(`input[name="${F.collaborateAll}"]`)!.checked).toBe(true);
    });
});
