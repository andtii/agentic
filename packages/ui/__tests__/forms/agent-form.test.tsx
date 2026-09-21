import { signal } from '@sigx/reactivity';
import type { AgentConfig } from '@agentic/core';
import { AgentForm, AGENT_FIELDS as F, CUSTOM_MODEL, agentDraftFromFormData, fromAgentDraft, toAgentDraft, type AgentErrors, type AgentFormApi, type AgentFormWorkdirProps, type RuntimeOption } from '@agentic/ui';
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

    it('edits execution.onInterrupt with a two-option select that explains itself (#368)', () => {
        const { form, root, state, submitted } = mountForm();
        const select = root.querySelector<HTMLSelectElement>(`select[name="${F.onInterrupt}"]`)!;
        expect([...select.options].map((o) => o.textContent)).toEqual(['Ask me', 'Resume automatically, once']);
        expect(select.value).toBe('ask');
        expect(labelOf(select)).toBe('When a turn is interrupted');
        expect(root.textContent).toContain('what ran before the cut is uncertain');
        setSelect(select, 'auto');
        submit(form);
        expect(submitted).toHaveLength(1);
        expect(state.config.execution.onInterrupt).toBe('auto');
    });

    it('hands the workdir slot the default environment and folder; a folder picked sets both and posts, another environment clears it (#193)', () => {
        const state = signal({ config: fullAgentConfig() });
        let slot: AgentFormWorkdirProps | null = null;
        const root = mount(
            <AgentForm
                model={() => state.config}
                environments={[{ value: 'env_1', label: 'Laptop' }, { value: 'env_2', label: 'Desktop' }]}
                slots={{ workdir: (p: AgentFormWorkdirProps) => { slot = p; return <span data-workdir-slot>{p.environmentId}|{p.path}</span>; } }}
            />
        );
        const form = root.querySelector('form')!;
        slot!.set({ environmentId: 'env_2', path: 'D:/src/app' });
        const picked = fromAgentDraft(agentDraftFromFormData(new FormData(form)));
        expect(picked.execution).toMatchObject({ defaultEnvironmentId: 'env_2', defaultWorkdir: 'D:/src/app' });
        expect(root.querySelector('[data-workdir-slot]')!.textContent).toBe('env_2|D:/src/app');

        setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.environment}"]`)!, 'env_1');
        const moved = fromAgentDraft(agentDraftFromFormData(new FormData(form)));
        expect(moved.execution.defaultEnvironmentId).toBe('env_1');
        expect(moved.execution).not.toHaveProperty('defaultWorkdir');

        slot!.set({ environmentId: 'env_1', path: 'C:/work' });
        slot!.set(null);
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form))).execution).not.toHaveProperty('defaultWorkdir');
    });

    it('binds the agent to an account (#414): the key round-trips as execution.account, picking one drops the pin and its folder, pinning drops the account, and a key of another runtime binds nothing', () => {
        const state = signal({ config: { ...fullAgentConfig(), execution: { ...fullAgentConfig().execution, defaultWorkdir: 'C:/work' } } as AgentConfig });
        const accounts = [
            { value: 'claude-code|id:me@work', label: 'work (me@work) — on pc, mac', runtime: 'claude-code' },
            { value: 'codex-cli|id:me@work', label: 'work (me@work) — on pc', runtime: 'codex-cli' }
        ];
        const root = mount(<AgentForm model={() => state.config} environments={[{ value: 'env_1', label: 'Laptop' }, { value: 'env_2', label: 'Desktop' }]} accounts={accounts} />);
        const form = root.querySelector('form')!;
        const accountSelect = root.querySelector<HTMLSelectElement>(`select[name="${F.account}"]`)!;
        // Only this runtime's accounts are offered.
        expect([...accountSelect.options].map((o) => o.value)).toEqual(['', 'claude-code|id:me@work']);
        expect(fromAgentDraft(agentDraftFromFormData(new FormData(form))).execution).toMatchObject({ defaultEnvironmentId: 'env_1', defaultWorkdir: 'C:/work' });
        setSelect(accountSelect, 'claude-code|id:me@work');
        const bound = fromAgentDraft(agentDraftFromFormData(new FormData(form))).execution;
        expect(bound.account).toEqual({ identity: 'me@work' });
        expect(bound).not.toHaveProperty('defaultEnvironmentId');
        expect(bound).not.toHaveProperty('defaultWorkdir');
        // Pinning again unbinds.
        setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.environment}"]`)!, 'env_2');
        const pinned = fromAgentDraft(agentDraftFromFormData(new FormData(form))).execution;
        expect(pinned).not.toHaveProperty('account');
        expect(pinned.defaultEnvironmentId).toBe('env_2');
        // The draft round-trips a bound config, and a stale key of another runtime binds nothing.
        const cfg = { ...fullAgentConfig(), execution: { runtime: 'claude-code', account: { identity: 'Me@Work' }, limits: {}, offlinePolicy: 'queue' as const } } as AgentConfig;
        expect(toAgentDraft(cfg).account).toBe('claude-code|id:me@work');
        expect(fromAgentDraft(toAgentDraft(cfg)).execution.account).toEqual({ identity: 'me@work' });
        expect(fromAgentDraft({ ...toAgentDraft(cfg), account: 'codex-cli|id:me@work' }).execution).not.toHaveProperty('account');
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

    describe('runtimes and models from the workspace (#234)', () => {
        const RUNTIMES: readonly RuntimeOption[] = [
            { value: 'anthropic-api', label: 'Anthropic API — needs a key', hint: 'Not set yet: anthropic-api-key.', href: '/plugins/anthropic-api', hrefLabel: 'Add the key', models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-opus-5' },
            { value: 'claude-code', label: 'Claude Code' }
        ];
        function mountWith(model: string, runtimes: readonly RuntimeOption[] = RUNTIMES) {
            const base = fullAgentConfig();
            const { model: _stored, ...execution } = base.execution;
            const state = signal({ config: { ...base, execution: { ...execution, runtime: 'anthropic-api', ...(model ? { model } : {}) } } as AgentConfig });
            const ref = { current: null as AgentFormApi | null };
            const root = mount(<AgentForm model={() => state.config} ref={ref} runtimes={runtimes} environments={[{ value: 'env_1', label: 'Laptop' }]} />);
            const form = root.querySelector('form')!;
            const modelSelect = () => root.querySelector<HTMLSelectElement>(`select[name="${F.model}"]`);
            const custom = () => root.querySelector<HTMLInputElement>(`input[name="${F.modelCustom}"]`);
            const posted = () => fromAgentDraft(agentDraftFromFormData(new FormData(form)));
            return { root, form, state, api: () => ref.current!, modelSelect, custom, posted };
        }

        it('offers the given runtimes; the chosen one says what is in the way and links to the fix', () => {
            const { root } = mountWith('');
            const select = root.querySelector<HTMLSelectElement>(`select[name="${F.runtime}"]`)!;
            expect([...select.options].map((o) => o.value)).toEqual(['anthropic-api', 'claude-code']);
            expect(select.selectedOptions[0]!.textContent).toBe('Anthropic API — needs a key');
            // The hint is the select's description, so a screen reader announces it with the field.
            const described = (select.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
            expect(described).toContain('Not set yet: anthropic-api-key.');
            expect(root.querySelector('[data-runtime-hint="anthropic-api"] [data-runtime-fix] a')!.getAttribute('href')).toBe('/plugins/anthropic-api');

            setSelect(select, 'claude-code');
            expect(root.querySelector('[data-runtime-hint]')).toBeNull();
        });

        it('the model select round-trips the runtime default, a listed model and a custom id', () => {
            const blank = mountWith('');
            expect(blank.modelSelect()!.value).toBe('');
            expect(blank.modelSelect()!.options[0]!.textContent).toBe('Runtime default (claude-opus-5)');
            expect(blank.posted().execution).not.toHaveProperty('model');

            setSelect(blank.modelSelect()!, 'claude-sonnet-5');
            expect(blank.api().draft.model).toBe('claude-sonnet-5');
            expect(blank.posted().execution.model).toBe('claude-sonnet-5');

            setSelect(blank.modelSelect()!, CUSTOM_MODEL);
            expect(blank.custom()).not.toBeNull();
            setText(blank.custom()!, 'claude-opus-4-1');
            expect(blank.api().draft.model).toBe('claude-opus-4-1');
            expect(blank.posted().execution.model).toBe('claude-opus-4-1');

            setSelect(blank.modelSelect()!, '');
            expect(blank.custom()).toBeNull();
            expect(blank.posted().execution).not.toHaveProperty('model');
        });

        it('a stored id the runtime does not list opens on Custom… with the id kept; reset() goes back to it', () => {
            const { modelSelect, custom, posted, api, state } = mountWith('claude-opus-4');
            expect(modelSelect()!.value).toBe(CUSTOM_MODEL);
            expect(custom()!.value).toBe('claude-opus-4');
            expect(posted().execution.model).toBe('claude-opus-4');

            setSelect(modelSelect()!, 'claude-opus-5');
            expect(custom()).toBeNull();
            api().reset();
            expect(modelSelect()!.value).toBe(CUSTOM_MODEL);
            expect(custom()!.value).toBe('claude-opus-4');
            expect(posted()).toEqual(state.config);
        });

        it('a runtime that lists no models keeps the typed model field', () => {
            const { root, modelSelect } = mountWith('');
            setSelect(root.querySelector<HTMLSelectElement>(`select[name="${F.runtime}"]`)!, 'claude-code');
            expect(modelSelect()).toBeNull();
            expect(root.querySelector<HTMLInputElement>(`input[name="${F.model}"]`)).not.toBeNull();
        });

        it('every control still has a label', () => {
            const { root, modelSelect, custom } = mountWith('claude-opus-4');
            expect(modelSelect()).not.toBeNull();
            expect(custom()).not.toBeNull();
            for (const el of controls(root)) expect(labelOf(el), `${el.tagName} name=${el.getAttribute('name')} has a label`).not.toBe('');
        });
    });
});

