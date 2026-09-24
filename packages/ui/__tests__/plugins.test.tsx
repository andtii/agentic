import { component } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { renderToString } from '@sigx/server-renderer';
import type { PluginReadiness, PluginReadinessStatus } from '@agentic/core';
import type { ToolMode } from '@agentic/core';
import { ConnectorTile, PluginCard, PluginRow, READINESS, ReadinessBadge, SecretField, Switch, TONES, ToolPolicyRow, readinessDetail } from '@agentic/ui';
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
        expect(one(root, 'badge', 'root')!.getAttribute('data-tone')).toBe('needs-you');
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
    it.each([
        ['ready', 'READY', 'live', false],
        ['disabled', 'OFF', 'dim', true],
        ['needs-secret', 'NEEDS KEY', 'needs-you', false],
        ['needs-machine', 'NEEDS MACHINE', 'needs-you', false],
        ['needs-config', 'NEEDS SETUP', 'needs-you', false],
        ['needs-grant', 'NEEDS GRANT', 'needs-you', false],
        ['needs-sign-in', 'NEEDS SIGN-IN', 'needs-you', false],
        ['no-kek', 'NO KEY STORE', 'needs-you', false]
    ] as const)('%s is the handoff pill %s (%s)', (status, label, tone, hollow) => {
        expect(READINESS[status]).toEqual({ label, tone, hollow });
        const pill = one(mount(<ReadinessBadge readiness={{ status }} />), 'badge', 'root')!;
        expect(pill.textContent).toBe(label);
        expect(pill.getAttribute('data-tone')).toBe(tone);
        expect(pill.getAttribute('data-variant')).toBe(hollow ? 'outline' : 'soft');
    });

    it('has a label and a product tone for every status core can report', () => {
        expect(Object.keys(READINESS).sort()).toEqual([...STATUSES].sort());
        for (const status of STATUSES) {
            expect(TONES).toContain(READINESS[status].tone);
            const root = mount(<ReadinessBadge readiness={{ status }} />);
            const pill = one(root, 'badge', 'root')!;
            expect(pill.getAttribute('data-tone')).toBe(READINESS[status].tone);
            expect(pill.hasAttribute('data-state')).toBe(false);
            expect(root.textContent).toBe(READINESS[status].label);
        }
    });

    it('says what is missing — in the title, and as text when asked', () => {
        const readiness: PluginReadiness = { status: 'needs-secret', missing: ['anthropic-api-key'] };
        expect(readinessDetail(readiness)).toBe('Not set yet: anthropic-api-key.');
        expect(readinessDetail({ status: 'ready' })).toBeUndefined();
        expect(readinessDetail({ status: 'needs-sign-in', missing: [] })).toBe('Signed out. Sign in again to reconnect.');
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

const rowPart = (root: ParentNode, part: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-plugin-row-part="${part}"]`);

describe('PluginRow', () => {
    it('lays out tile, title, kind, readiness, dependents, toggle and chevron on the 60 px grid', () => {
        const root = mount(
            <PluginRow id="claude-code" name="Claude Code" version="0.1.0" features={['usage limits']} description="Drives Claude Code through its SDK." kind="harness" readiness={{ status: 'ready' }} href="/plugins/claude-code" slots={{ dependents: () => 'No dependents', toggle: () => <button type="button">toggle</button> }} />
        );
        const row = root.querySelector<HTMLAnchorElement>('a[data-plugin-row]')!;
        expect(row.getAttribute('href')).toBe('/plugins/claude-code');
        expect(row.getAttribute('data-plugin')).toBe('claude-code');
        expect(row.getAttribute('data-plugin-row')).toBe('default');
        expect(row.style.gridTemplateColumns).toBe('36px minmax(0, 1fr) 150px 150px 120px 44px 20px');
        expect(row.getAttribute('style')).toContain('min-block-size: 60px');
        expect([...row.children].map((c) => c.getAttribute('data-plugin-row-part'))).toEqual(['tile', 'title', 'kind', 'readiness', 'dependents', 'toggle', 'chevron']);
        expect(rowPart(root, 'tile')!.textContent).toBe('CC');
        expect(rowPart(root, 'name')!.textContent).toBe('Claude Code');
        expect(rowPart(root, 'version')!.textContent).toBe('0.1.0');
        expect(rowPart(root, 'title')!.textContent).toContain('usage limits');
        expect(rowPart(root, 'description')!.textContent).toBe('Drives Claude Code through its SDK.');
        expect(rowPart(root, 'kind')!.textContent).toBe('harness');
        expect(rowPart(root, 'readiness')!.textContent).toBe('READY');
        expect(rowPart(root, 'dependents')!.textContent).toBe('No dependents');
        expect(rowPart(root, 'chevron')!.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
    });

    it('without href it is not a link', () => {
        const root = mount(<PluginRow name="Git" readiness={{ status: 'ready' }} />);
        expect(root.querySelector('a')).toBeNull();
        expect(root.querySelector('div[data-plugin-row]')).not.toBeNull();
        expect(rowPart(root, 'chevron')!.childElementCount).toBe(0);
    });

    it('a click or keydown in the toggle or fix slot never reaches the row link; the switch still toggles', async () => {
        const st = signal({ on: true });
        let signIns = 0;
        const root = mount(
            <PluginRow name="Linear" variant="connector" readiness={{ status: 'needs-sign-in' }} href="/plugins/linear" slots={{ toggle: () => <Switch label="Enable Linear" hideLabel model={() => st.on} />, fix: () => <button type="button" onClick={() => signIns++}>Sign in</button> }} />
        );
        const row = root.querySelector('a')!;
        const seen: string[] = [];
        row.addEventListener('click', () => seen.push('click'));
        row.addEventListener('keydown', () => seen.push('keydown'));
        root.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await tick();
        expect(st.on).toBe(false);
        buttonNamed(root, 'Sign in').click();
        expect(signIns).toBe(1);
        rowPart(root, 'toggle')!.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        buttonNamed(root, 'Sign in').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(seen).toEqual([]);
        // the rest of the row is the link
        rowPart(root, 'name')!.click();
        rowPart(root, 'readiness')!.querySelector<HTMLElement>('[data-scope="badge"][data-part="root"]')!.click();
        expect(seen).toEqual(['click', 'click']);
    });

    it('a click on the empty space of a slot cancels the row link; a click on the control inside does not', () => {
        const root = mount(<PluginRow name="Linear" variant="connector" href="/plugins/linear" slots={{ toggle: () => <button type="button">toggle</button> }} />);
        const empty = new MouseEvent('click', { bubbles: true, cancelable: true });
        rowPart(root, 'toggle')!.dispatchEvent(empty);
        expect(empty.defaultPrevented).toBe(true);
        const onControl = new MouseEvent('click', { bubbles: true, cancelable: true });
        buttonNamed(root, 'toggle').dispatchEvent(onControl);
        expect(onControl.defaultPrevented).toBe(false);
    });

    it('the connector variant: its own grid, the mono account line, the transport and an inline fix', () => {
        const root = mount(<PluginRow name="Linear" variant="connector" description="mcp.linear.app · token expired" kind="mcp" readiness={{ status: 'needs-sign-in' }} slots={{ fix: () => <button type="button">Sign in</button> }} />);
        const row = root.querySelector<HTMLElement>('[data-plugin-row]')!;
        expect(row.getAttribute('data-plugin-row')).toBe('connector');
        expect(row.style.gridTemplateColumns).toBe('36px minmax(0, 1fr) 90px 230px 100px 44px 20px');
        expect(row.getAttribute('data-readiness')).toBe('needs-sign-in');
        expect(rowPart(root, 'description')!.getAttribute('style')).toContain('font-family: var(--font-mono)');
        expect(rowPart(root, 'kind')!.textContent).toBe('mcp');
        expect(rowPart(root, 'readiness')!.textContent).toBe('NEEDS SIGN-IN' + 'Sign in');
    });

    it('the radio variant: the active one has a filled dot and ACTIVE, the others the action and the consequence', () => {
        const active = mount(<PluginRow name="Memory" variant="radio" active href="/plugins/memory" slots={{ action: () => <button type="button">Make active</button> }} />);
        const row = active.querySelector<HTMLElement>('[data-plugin-row="radio"]')!;
        expect(row.hasAttribute('data-active')).toBe(true);
        expect(rowPart(active, 'radio')!.childElementCount).toBe(1);
        expect(one(active, 'badge', 'root')!.textContent).toBe('ACTIVE');
        expect(one(active, 'badge', 'root')!.getAttribute('data-tone')).toBe('live');
        expect(active.textContent).not.toContain('Make active');

        let made = 0;
        const other = mount(<PluginRow name="Flat memory" variant="radio" consequence="switching into it drops conditions" href="/plugins/flat-memory" slots={{ action: () => <button type="button" onClick={() => made++}>Make active</button> }} />);
        const link = other.querySelector('a')!;
        let clicks = 0;
        link.addEventListener('click', () => clicks++);
        expect(rowPart(other, 'radio')!.childElementCount).toBe(0);
        expect(one(other, 'badge', 'root')).toBeNull();
        expect(rowPart(other, 'consequence')!.textContent).toBe('switching into it drops conditions');
        buttonNamed(other, 'Make active').click();
        expect(made).toBe(1);
        expect(clicks).toBe(0);
    });
});

describe('ConnectorTile', () => {
    it('is a button with the monogram, name, transport and description', () => {
        let selects = 0;
        const root = mount(<ConnectorTile id="google-calendar" name="Google Calendar" transport="conduit" description="Read and create events." onSelect={() => selects++} />);
        const tile = root.querySelector('button')!;
        expect(tile.getAttribute('type')).toBe('button');
        expect(tile.getAttribute('aria-pressed')).toBe('false');
        expect(tile.getAttribute('data-connector')).toBe('google-calendar');
        expect(one(root, 'avatar', 'fallback')!.textContent).toBe('GC');
        expect(root.querySelector('[data-connector-part="transport"]')!.getAttribute('style')).toContain('text-transform: uppercase');
        expect(root.querySelector('[data-connector-part="description"]')!.textContent).toBe('Read and create events.');
        expect(root.querySelector('[data-connector-part="connected"]')).toBeNull();
        tile.click();
        expect(selects).toBe(1);
    });

    it('selected: pressed, base-300 fill and the live border at 53 %', () => {
        const tile = mount(<ConnectorTile name="Google Calendar" transport="conduit" selected />).querySelector('button')!;
        expect(tile.getAttribute('aria-pressed')).toBe('true');
        expect(tile.hasAttribute('data-selected')).toBe(true);
        const style = tile.getAttribute('style')!;
        expect(style).toContain('background: var(--color-base-300)');
        expect(style).toContain('color-mix(in oklab, var(--color-primary) 53%, transparent)');
    });

    it('connected: dimmed with a Connected check, still selectable', () => {
        let selects = 0;
        const root = mount(<ConnectorTile name="Gmail" transport="conduit" connected onSelect={() => selects++} />);
        const tile = root.querySelector('button')!;
        expect(tile.hasAttribute('data-connected')).toBe(true);
        expect(tile.getAttribute('style')).toContain('color: var(--ag-text-muted)');
        const check = root.querySelector('[data-connector-part="connected"]')!;
        expect(check.textContent).toBe('Connected');
        expect(check.querySelector('[data-icon="check"]')).not.toBeNull();
        tile.click();
        expect(selects).toBe(1);
    });
});

describe('ToolPolicyRow', () => {
    const items = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-scope="toggle-group"][data-part="item"]')];

    it('shows the tool over its description and binds allow / ask / deny in their tones', async () => {
        const st = signal({ mode: 'ask' as ToolMode });
        const changes: ToolMode[] = [];
        const root = mount(<ToolPolicyRow name="gmail__send-email" description="Send a message" model={() => st.mode} onValueChange={(v) => changes.push(v)} />);
        expect(root.querySelector('[data-tool-policy-part="name"]')!.textContent).toBe('gmail__send-email');
        expect(root.querySelector('[data-tool-policy-part="name"]')!.getAttribute('style')).toContain('font-family: var(--font-mono)');
        expect(root.querySelector('[data-tool-policy-part="description"]')!.textContent).toBe('Send a message');
        expect(root.querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Approval for gmail__send-email');
        expect(items(root).map((i) => i.textContent)).toEqual(['allow', 'ask', 'deny']);
        expect(items(root).map((i) => i.getAttribute('data-tone'))).toEqual(['live', 'needs-you', 'failed']);
        expect(items(root).map((i) => i.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
        expect(items(root)[2]!.getAttribute('style')).toContain('color-mix(in oklab, var(--color-error) 15%, transparent)');
        items(root)[2]!.click();
        await tick();
        expect(st.mode).toBe('deny');
        expect(changes).toEqual(['deny']);
        st.mode = 'allow';
        await tick();
        expect(items(root).map((i) => i.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    });

    it('disabled and pending leave the mode alone; pending says busy', async () => {
        const st = signal({ mode: 'allow' as ToolMode, pending: true, disabled: false });
        const Host = component(() => () => <ToolPolicyRow name="gmail__search" model={() => st.mode} pending={st.pending} disabled={st.disabled} />);
        const root = mount(<Host />);
        expect(root.querySelector('[data-tool-policy]')!.getAttribute('aria-busy')).toBe('true');
        items(root)[1]!.click();
        await tick();
        expect(st.mode).toBe('allow');
        st.pending = false;
        st.disabled = true;
        await tick();
        expect(root.querySelector('[data-tool-policy]')!.hasAttribute('aria-busy')).toBe(false);
        items(root)[1]!.click();
        await tick();
        expect(st.mode).toBe('allow');
        st.disabled = false;
        await tick();
        items(root)[1]!.click();
        await tick();
        expect(st.mode).toBe('ask');
    });
});
