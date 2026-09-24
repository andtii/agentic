import { component } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { renderToString } from '@sigx/server-renderer';
import type { PluginReadiness, PluginReadinessStatus } from '@agentic/core';
import { PluginCard, READINESS, ReadinessBadge, SecretField, TONES, readinessDetail } from '@agentic/ui';
import { buttonNamed, mount, one, tick } from './helpers';

const SECRET = 'sk-ant-test-0123456789';
const STATUSES: PluginReadinessStatus[] = ['ready', 'disabled', 'needs-config', 'needs-secret', 'needs-grant', 'needs-sign-in', 'needs-machine', 'no-kek'];

function setText(el: HTMLInputElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function mountSecret(initial: { isSet: boolean; required?: boolean }) {
    const st = signal({ isSet: initial.isSet, saving: false, error: '' });
    const saved: string[] = [];
    let removed = 0;
    const Host = component(() => () => (
        <SecretField name="anthropic-api-key" label="Anthropic API key" description="Used by the anthropic-api runtime." required={initial.required} isSet={st.isSet} saving={st.saving} error={st.error} onSave={(v) => saved.push(v)} onRemove={() => removed++} />
    ));
    const root = mount(<Host />);
    return { st, root, saved, removed: () => removed, field: () => root.querySelector<HTMLInputElement>('input[type="password"]') };
}

describe('SecretField', () => {
    it('server-renders an input that cannot take or post a secret: disabled, no name, no value', async () => {
        const html = await renderToString(<SecretField name="anthropic-api-key" label="Anthropic API key" isSet={false} required />);
        const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0];
        expect(input, html).toBeDefined();
        expect(input).toMatch(/\sdisabled(=|\s|>|\/)/);
        expect(input).not.toMatch(/\sname=/);
        expect(input).toMatch(/autocomplete="off"/i);
        expect(input).not.toMatch(/\svalue="[^"]/);
        // the form around it never GETs, and its submit button is inert until the page is live
        expect(/<form[^>]*>/.exec(html)![0]).toMatch(/method="post"/);
        expect(/<button[^>]*type="submit"[^>]*>/.exec(html)![0]).toMatch(/\sdisabled(=|\s|>|\/)/);
    });

    it('never server-renders a field at all for a secret that is set', async () => {
        const html = await renderToString(<SecretField name="k" label="Key" isSet />);
        expect(html).not.toMatch(/<input/);
        expect(html).toContain('SET');
    });

    it('once mounted the input is live — still without a name', () => {
        const { field, root } = mountSecret({ isSet: false, required: true });
        expect(field()!.disabled).toBe(false);
        expect(field()!.hasAttribute('name')).toBe(false);
        expect(field()!.getAttribute('autocomplete')).toBe('off');
        expect(root.textContent).toContain('NOT SET');
        expect(one(root, 'ag-pill', 'root')!.getAttribute('data-tone')).toBe('needs-you');
        expect(root.querySelector('form')!.getAttribute('method')).toBe('post');
    });

    it('save emits the value once, prevents the native post and forgets what was typed', async () => {
        const { field, root, saved, st } = mountSecret({ isSet: false });
        const save = buttonNamed(root, 'Save');
        expect(save.disabled).toBe(true);
        setText(field()!, SECRET);
        await tick();
        expect(save.disabled).toBe(false);
        const event = new Event('submit', { bubbles: true, cancelable: true });
        root.querySelector('form')!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(saved).toEqual([SECRET]);
        await tick();
        expect(field()!.value).toBe('');
        expect(root.innerHTML).not.toContain(SECRET);
        // the write landed: the resting state has no input at all
        st.isSet = true;
        await tick();
        expect(field()).toBeNull();
        expect(root.textContent).toContain('SET');
        expect(root.innerHTML).not.toContain(SECRET);
    });

    it('an empty save emits nothing', () => {
        const { root, saved } = mountSecret({ isSet: false });
        root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(saved).toEqual([]);
    });

    it('Replace opens the editor and Cancel drops the draft', async () => {
        const { field, root, saved } = mountSecret({ isSet: true });
        expect(field()).toBeNull();
        buttonNamed(root, 'Replace').click();
        await tick();
        setText(field()!, SECRET);
        buttonNamed(root, 'Cancel').click();
        await tick();
        expect(field()).toBeNull();
        expect(saved).toEqual([]);
        buttonNamed(root, 'Replace').click();
        await tick();
        expect(field()!.value).toBe('');
    });

    it('Remove asks twice', async () => {
        const { root, removed } = mountSecret({ isSet: true });
        buttonNamed(root, 'Remove').click();
        await tick();
        expect(removed()).toBe(0);
        buttonNamed(root, 'Confirm remove').click();
        expect(removed()).toBe(1);
    });

    it('shows the refusal of a write as the field’s accessible error', async () => {
        const { root, st } = mountSecret({ isSet: false });
        st.error = 'no-kek: secrets cannot be stored';
        await tick();
        expect(root.querySelector('[role="alert"]')!.textContent).toBe('no-kek: secrets cannot be stored');
    });
});

describe('ReadinessBadge', () => {
    it('has a label and a product tone for every status core can report', () => {
        expect(Object.keys(READINESS).sort()).toEqual([...STATUSES].sort());
        for (const status of STATUSES) {
            expect(TONES).toContain(READINESS[status].tone);
            const root = mount(<ReadinessBadge readiness={{ status }} />);
            const pill = one(root, 'ag-pill', 'root')!;
            expect(pill.getAttribute('data-tone')).toBe(READINESS[status].tone);
            expect(pill.hasAttribute('data-state')).toBe(false);
            expect(root.textContent).toBe(READINESS[status].label);
        }
    });

    it('says what is missing — in the title, and as text when asked', () => {
        const readiness: PluginReadiness = { status: 'needs-secret', missing: ['anthropic-api-key'] };
        expect(readinessDetail(readiness)).toBe('Not set yet: anthropic-api-key.');
        expect(readinessDetail({ status: 'ready' })).toBeUndefined();
        const quiet = mount(<ReadinessBadge readiness={readiness} />);
        expect(one(quiet, 'ag-plugin-card', 'readiness')!.getAttribute('title')).toBe('Not set yet: anthropic-api-key.');
        expect(one(quiet, 'ag-plugin-card', 'readiness-detail')).toBeNull();
        const loud = mount(<ReadinessBadge readiness={readiness} detail />);
        expect(one(loud, 'ag-plugin-card', 'readiness-detail')!.textContent).toBe('Not set yet: anthropic-api-key.');
    });
});

describe('PluginCard', () => {
    it('shows name, version, kind, description and readiness, with the page’s slots', () => {
        const root = mount(
            <PluginCard id="anthropic-api" name="Anthropic API" kind="runtime" version="1.0.0" description="Runs agents on the Anthropic API." readiness={{ status: 'needs-secret', missing: ['anthropic-api-key'] }} slots={{ toggle: () => <button type="button">toggle</button>, meta: () => 'No dependents', configure: () => <a href="/plugins/anthropic-api">Configure</a>, default: () => <p data-body>body</p> }} />
        );
        const card = one(root, 'ag-plugin-card', 'root')!;
        expect(card.getAttribute('aria-label')).toBe('Anthropic API');
        expect(card.getAttribute('data-plugin')).toBe('anthropic-api');
        expect(card.getAttribute('data-tone')).toBe('needs-you');
        expect(one(root, 'ag-plugin-card', 'name')!.textContent).toBe('Anthropic API1.0.0');
        expect(one(root, 'ag-plugin-card', 'tags')!.textContent).toBe('runtimeNEEDS KEY');
        expect(one(root, 'ag-plugin-card', 'description')!.textContent).toBe('Runs agents on the Anthropic API.');
        expect(one(root, 'ag-plugin-card', 'header')!.querySelector('button')!.textContent).toBe('toggle');
        expect(root.querySelector('[data-body]')).not.toBeNull();
        expect(one(root, 'ag-plugin-card', 'meta')!.textContent).toBe('No dependents');
        expect(one(root, 'ag-plugin-card', 'footer')!.querySelector('a')!.getAttribute('href')).toBe('/plugins/anthropic-api');
    });

    it('a ready plugin is quiet, a disabled one dims, the active one of its kind is marked', () => {
        const ready = one(mount(<PluginCard name="Claude Code" kind="runtime" readiness={{ status: 'ready' }} />), 'ag-plugin-card', 'root')!;
        expect(ready.hasAttribute('data-tone')).toBe(false);
        expect(ready.querySelector('footer')).toBeNull();
        const off = one(mount(<PluginCard name="Flat memory" kind="memory" readiness={{ status: 'disabled' }} />), 'ag-plugin-card', 'root')!;
        expect(off.getAttribute('data-tone')).toBe('dim');
        const active = mount(<PluginCard name="Default memory" kind="memory" readiness={{ status: 'ready' }} active />);
        expect(one(active, 'ag-plugin-card', 'root')!.hasAttribute('data-mod-selected')).toBe(true);
        expect(one(active, 'ag-plugin-card', 'tags')!.textContent).toBe('memoryactiveREADY');
    });
});
