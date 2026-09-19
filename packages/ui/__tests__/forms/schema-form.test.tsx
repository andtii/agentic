import { component } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import type { ConfigSchema } from '@agentic/core';
import { SchemaForm, fromSchemaDraft, schemaFields, schemaLabel, toSchemaDraft, validateSchemaDraft, type SchemaErrors, type SchemaFormApi } from '@agentic/ui';
import { buttonNamed, tick } from '../helpers';
import { controls, describedByRole, labelOf, mount, setSelect, setText, submit, toggle } from './helpers';

const schema: ConfigSchema = {
    type: 'object',
    properties: {
        defaultModel: { type: 'string', enum: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-sonnet-5', title: 'Default model', description: 'Used when an agent names none.' },
        endpoint: { type: 'string', format: 'uri' },
        note: { type: 'string' },
        retries: { type: 'integer', minimum: 0, maximum: 5, default: 2 },
        verbose: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        modes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] }, default: ['read'] },
        headers: { type: 'object', additionalProperties: { type: 'string' } }
    },
    required: ['endpoint']
};

function mountForm(value: Record<string, unknown> = { endpoint: 'https://mcp.example/' }, s: ConfigSchema = schema) {
    const state = signal({ value, error: '' });
    const ref = { current: null as SchemaFormApi | null };
    const submitted: Record<string, unknown>[] = [];
    const invalid: SchemaErrors[] = [];
    const Host = component(() => () => <SchemaForm ref={ref} schema={s} value={state.value} error={state.error} onSubmit={(c) => submitted.push(c)} onInvalid={(e) => invalid.push(e)} />);
    const root = mount(<Host />);
    return { state, root, form: root.querySelector('form')!, api: () => ref.current!, submitted, invalid };
}

const input = (root: HTMLElement, name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

describe('schema model', () => {
    it('names a field by its title, else by its key in words', () => {
        expect(schemaLabel('defaultModel')).toBe('Default model');
        expect(schemaLabel('max_wall-ms')).toBe('Max wall ms');
        expect(schemaLabel('x', 'The X')).toBe('The X');
    });

    it('maps each property type to its control, in declaration order', () => {
        expect(schemaFields(schema).map((f) => [f.key, f.kind, f.required])).toEqual([
            ['defaultModel', 'select', false],
            ['endpoint', 'text', true],
            ['note', 'text', false],
            ['retries', 'number', false],
            ['verbose', 'switch', false],
            ['tags', 'list', false],
            ['modes', 'list', false],
            ['headers', 'map', false]
        ]);
        expect(schemaFields({ type: 'object' })).toEqual([]);
        expect(schemaFields({})).toEqual([]);
    });

    it('shows the defaults and writes back a sparse config', () => {
        const source = { endpoint: 'https://mcp.example/' };
        const draft = toSchemaDraft(schema, source);
        expect(draft.text.defaultModel).toBe('claude-sonnet-5');
        expect(draft.number.retries).toBe(2);
        expect(draft.list.modes).toEqual(['read']);
        // untouched defaults are not written: the stored config keeps following the manifest
        expect(fromSchemaDraft(schema, draft, source)).toEqual({ endpoint: 'https://mcp.example/' });
        // a switch left off with no declared default is "not set" — unless the stored config said `false`, or it is turned on
        expect(fromSchemaDraft(schema, draft, { ...source, verbose: false })).toEqual({ endpoint: 'https://mcp.example/', verbose: false });
        draft.flag.verbose = true;
        expect(fromSchemaDraft(schema, draft, source)).toEqual({ endpoint: 'https://mcp.example/', verbose: true });
        draft.flag.verbose = false;
        // a REQUIRED switch has to answer, so `false` is written
        const must: ConfigSchema = { type: 'object', properties: { agree: { type: 'boolean' } }, required: ['agree'] };
        expect(fromSchemaDraft(must, toSchemaDraft(must, {}), {})).toEqual({ agree: false });
        expect(validateSchemaDraft(must, toSchemaDraft(must, {}))).toEqual({});
        draft.text.defaultModel = 'claude-opus-5';
        draft.number.retries = 4;
        draft.list.modes = [];
        draft.map.headers = [{ key: ' X-Team ', value: 'core' }, { key: '', value: '' }];
        expect(fromSchemaDraft(schema, draft, source)).toEqual({ endpoint: 'https://mcp.example/', defaultModel: 'claude-opus-5', retries: 4, modes: [], headers: { 'X-Team': 'core' } });
    });

    it('keeps a key the source already carried, and whatever the form cannot draw', () => {
        const odd = { type: 'object', properties: { known: { type: 'string', default: 'a' }, shape: { type: 'tuple' } }, additionalProperties: true } as unknown as ConfigSchema;
        const source = { known: 'a', shape: [1, 2], extra: { deep: true } };
        expect(schemaFields(odd).map((f) => f.key)).toEqual(['known']);
        expect(fromSchemaDraft(odd, toSchemaDraft(odd, source), source)).toEqual(source);
    });

    it('a `__proto__` row stays data', () => {
        const draft = toSchemaDraft(schema, {});
        draft.map.headers = [{ key: '__proto__', value: 'x' }];
        const out = fromSchemaDraft(schema, draft, {});
        expect(Object.hasOwn(out.headers as object, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('validates through core, reading over the defaults, plus half-edited maps', () => {
        const draft = toSchemaDraft(schema, {});
        expect(validateSchemaDraft(schema, draft)).toEqual({ endpoint: 'Is required' });
        draft.text.endpoint = 'not a url';
        draft.number.retries = 9;
        draft.map.headers = [{ key: 'a', value: '1' }, { key: 'a', value: '2' }];
        expect(validateSchemaDraft(schema, draft)).toEqual({ endpoint: 'Must be an absolute URL', retries: 'Must be at most 5', headers: 'Each name can appear once' });
        draft.map.headers = [{ key: '', value: 'orphan' }];
        expect(validateSchemaDraft(schema, draft).headers).toBe('Every row needs a name');
    });
});

describe('SchemaForm', () => {
    it('renders one labelled control per property, of the right kind', () => {
        const { root } = mountForm();
        for (const el of controls(root)) expect(labelOf(el), `${el.getAttribute('name') ?? el.getAttribute('role')} has a label`).not.toBe('');
        expect(root.querySelector('select[name="defaultModel"]')).not.toBeNull();
        expect(input(root, 'endpoint').type).toBe('url');
        expect(input(root, 'endpoint').required).toBe(true);
        expect(input(root, 'note').type).toBe('text');
        expect(input(root, 'verbose').type).toBe('checkbox');
        expect(root.querySelectorAll('[data-scope="ai-multi-select"][data-part="root"]').length).toBe(2);
        expect(root.querySelector('[data-scope="ag-map-field"][data-part="root"]')).not.toBeNull();
        expect(labelOf(root.querySelector<HTMLElement>('select[name="defaultModel"]')!)).toBe('Default model');
        expect(root.textContent).toContain('Used when an agent names none.');
    });

    it('an empty schema says so, quietly, with no buttons', () => {
        for (const s of [{}, { type: 'object' as const }, { type: 'object' as const, properties: {} }]) {
            const { root, form } = mountForm({}, s);
            expect(form.textContent).toContain('Nothing to configure.');
            expect(root.querySelectorAll('button').length).toBe(0);
        }
    });

    it('edits bind through the draft and a valid submit emits the sparse config', () => {
        const { root, form, api, submitted } = mountForm();
        expect(api().dirty()).toBe(false);
        setSelect(root.querySelector<HTMLSelectElement>('select[name="defaultModel"]')!, 'claude-opus-5');
        setText(input(root, 'note'), ' hello ');
        toggle(input(root, 'verbose'), true);
        expect(api().dirty()).toBe(true);
        submit(form);
        expect(submitted).toEqual([{ endpoint: 'https://mcp.example/', defaultModel: 'claude-opus-5', note: 'hello', verbose: true }]);
    });

    it('edits a string map row by row', async () => {
        const { root, form, submitted } = mountForm();
        buttonNamed(root, 'Add row').click();
        await tick();
        setText(input(root, 'headers.key'), 'X-Team');
        setText(input(root, 'headers.value'), 'core');
        buttonNamed(root, 'Add row').click();
        await tick();
        expect(root.querySelectorAll('[data-scope="ag-map-field"][data-part="row"]').length).toBe(2);
        expect(labelOf(root.querySelectorAll<HTMLInputElement>('input[name="headers.value"]')[1]!)).toBe('Headers value 2');
        buttonNamed(root, 'Remove Headers row 2').click();
        await tick();
        expect(root.querySelectorAll('[data-scope="ag-map-field"][data-part="row"]').length).toBe(1);
        submit(form);
        expect(submitted.at(-1)).toMatchObject({ headers: { 'X-Team': 'core' } });
    });

    it('blocks an invalid config with accessible errors from core, and writes nothing', async () => {
        const { root, form, api, submitted, invalid } = mountForm();
        setText(input(root, 'endpoint'), 'nope');
        // nothing is shown before the first attempt
        expect(root.querySelector('[role="alert"]')).toBeNull();
        submit(form);
        await tick();
        expect(submitted).toEqual([]);
        expect(invalid).toEqual([{ endpoint: 'Must be an absolute URL' }]);
        expect(api().errors()).toEqual({ endpoint: 'Must be an absolute URL' });
        const field = input(root, 'endpoint');
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(describedByRole(field, 'alert').map((e) => e.textContent)).toEqual(['Must be an absolute URL']);
        setText(field, 'https://ok.example/');
        await tick();
        expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows what no field can carry — the write’s refusal and a key the schema does not draw — in the summary', async () => {
        const closed: ConfigSchema = { type: 'object', properties: { note: { type: 'string' } } };
        const { root, form, state } = mountForm({ stale: 1 }, closed);
        submit(form);
        await tick();
        expect(root.querySelector('[data-part="summary"]')!.textContent).toContain('stale: Is not a setting of this plugin');
        state.error = 'bad-config';
        await tick();
        expect(root.querySelector('[data-part="summary"]')!.getAttribute('role')).toBe('alert');
    });

    it('reset() returns to the stored config', () => {
        const { root, api } = mountForm();
        setText(input(root, 'note'), 'x');
        expect(api().dirty()).toBe(true);
        api().reset();
        expect(api().dirty()).toBe(false);
        expect(api().draft.text.note).toBe('');
    });
});

describe('SchemaForm following a live read', () => {
    function mountLive() {
        const state = signal({ value: { endpoint: 'https://a.example/' } as Record<string, unknown> });
        const ref = { current: null as SchemaFormApi | null };
        const Host = component(() => () => <SchemaForm ref={ref} schema={schema} value={state.value} />);
        const root = mount(<Host />);
        return { state, root, api: () => ref.current! };
    }

    it('takes up a changed stored config while clean, never over an edit', async () => {
        const { state, root, api } = mountLive();
        state.value = { endpoint: 'https://b.example/' };
        await tick();
        expect(input(root, 'endpoint').value).toBe('https://b.example/');
        setText(input(root, 'note'), 'mine');
        state.value = { endpoint: 'https://c.example/' };
        await tick();
        expect(input(root, 'endpoint').value).toBe('https://b.example/');
        expect(api().draft.text.note).toBe('mine');
    });
});
