/**
 * The controls: Button intents on the daisy axes, the segmented control's
 * `aria-pressed` and tones, the switch's `role="switch"`, the confirm
 * dialog's dependents and consequence.
 */
import { signal } from '@sigx/runtime-core';
import { BUTTON_INTENTS, Button, ConfirmDialog, Segmented, Switch, buttonAxes, segmentStyle } from '@agentic/ui';
import { buttonNamed, mount, tick } from '../helpers';

describe('Button', () => {
    it.each([
        ['primary', 'primary', 'solid', []],
        ['default', 'neutral', 'solid', []],
        ['wait', 'warning', 'solid', []],
        ['danger', 'error', 'outline', []],
        ['icon', 'neutral', 'solid', ['square']]
    ] as const)('%s renders color %s, variant %s', (intent, color, variant, mods) => {
        const root = mount(<Button intent={intent} label={intent === 'icon' ? 'Search' : undefined} icon={intent === 'icon' ? 'search' : undefined}>Go</Button>);
        const button = root.querySelector('button')!;
        expect(button.getAttribute('data-scope')).toBe('button');
        expect(button.getAttribute('data-part')).toBe('root');
        expect(button.getAttribute('data-color')).toBe(color);
        expect(button.getAttribute('data-variant')).toBe(variant);
        expect(button.getAttribute('data-intent')).toBe(intent);
        expect(button.getAttribute('type')).toBe('button');
        for (const mod of mods) expect(button.hasAttribute(`data-mod-${mod}`)).toBe(true);
        expect(BUTTON_INTENTS).toContain(intent);
    });

    it('fills a danger button at the confirm step', () => {
        expect(buttonAxes('danger').variant).toBe('outline');
        expect(buttonAxes('danger', true).variant).toBe('solid');
    });

    it('requires an accessible name for an icon button and sets it', () => {
        expect(() => mount(<Button intent="icon" icon="search" />)).toThrow(/aria-label/);
        const root = mount(<Button intent="icon" icon="search" label="Search chats" />);
        const button = root.querySelector('button')!;
        expect(button.getAttribute('aria-label')).toBe('Search chats');
        expect(button.querySelector('svg')!.getAttribute('data-icon')).toBe('search');
        expect(button.querySelector('span')).toBeNull();
    });

    it('keeps the label while loading, swaps the icon for the spinner mod, disables and announces busy', () => {
        const root = mount(<Button intent="primary" icon="check" loading>Allow once</Button>);
        const button = root.querySelector('button')!;
        expect(button.textContent).toBe('Allow once');
        expect(button.querySelector('svg')).toBeNull();
        expect(button.hasAttribute('data-mod-loading')).toBe(true);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
    });

    it('emits clicks and spans the row with block', () => {
        let clicks = 0;
        const root = mount(<Button block onClick={() => clicks++}>Send</Button>);
        buttonNamed(root, 'Send').click();
        expect(clicks).toBe(1);
        expect(root.querySelector('button')!.hasAttribute('data-mod-block')).toBe(true);
    });
});

describe('Segmented', () => {
    const options = [
        { value: 'allow', label: 'Allow', tone: 'live' as const },
        { value: 'ask', label: 'Ask', tone: 'needs-you' as const },
        { value: 'deny', label: 'Deny', tone: 'failed' as const }
    ];

    it('renders a labelled group of aria-pressed segments, the selected one in its tone', async () => {
        const state = signal({ policy: 'ask' });
        const changes: string[] = [];
        const root = mount(<Segmented label="Approval for destructive tools" options={options} model={() => state.policy} onValueChange={(v) => changes.push(v)} />);
        const group = root.querySelector('[role="group"]')!;
        expect(group.getAttribute('aria-label')).toBe('Approval for destructive tools');
        const items = [...root.querySelectorAll<HTMLButtonElement>('[data-scope="toggle-group"][data-part="item"]')];
        expect(items.map((i) => i.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
        expect(items.map((i) => i.getAttribute('data-tone'))).toEqual(['live', 'needs-you', 'failed']);
        expect(items[1]!.getAttribute('style')).toContain('--toggle-group-on-accent: var(--color-warning)');
        items[2]!.click();
        await tick();
        expect(state.policy).toBe('deny');
        expect(changes).toEqual(['deny']);
        expect(items.map((i) => i.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
        // A model change from outside moves the selection.
        state.policy = 'allow';
        await tick();
        expect(items.map((i) => i.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    });

    it('paints the selected segment at 15 % of its meaning colour', () => {
        expect(segmentStyle('failed')).toBe('--toggle-group-accent: color-mix(in oklab, var(--color-error) 15%, transparent); --toggle-group-on-accent: var(--color-error)');
        expect(segmentStyle(undefined)).toBeUndefined();
    });
});

describe('Switch', () => {
    it('is a real switch with its label', async () => {
        const state = signal({ on: false });
        const toggles: boolean[] = [];
        const root = mount(<Switch label="Enable" model={() => state.on} onCheckedChange={(v) => toggles.push(v)} />);
        const control = root.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(control.checked).toBe(false);
        expect(root.querySelector('[data-scope="switch"][data-part="root"]')!.getAttribute('data-state')).toBe('unchecked');
        expect(root.textContent).toContain('Enable');
        control.click();
        await tick();
        expect(state.on).toBe(true);
        expect(toggles).toEqual([true]);
        expect(root.querySelector('[data-scope="switch"][data-part="root"]')!.getAttribute('data-state')).toBe('checked');
    });

    it('can hide its label visually while keeping it in the tree', () => {
        const root = mount(<Switch label="Enable schedule" hideLabel />);
        expect(root.querySelector('[data-visually-hidden]')!.textContent).toBe('Enable schedule');
    });
});

describe('ConfirmDialog', () => {
    it('is an alert dialog that lists every dependent by name and states the consequence', async () => {
        const state = signal({ open: true });
        const events: string[] = [];
        const root = mount(
            <ConfirmDialog
                model={() => state.open}
                title="Disable sigx-actors?"
                description="Two sessions use it."
                dependents={['Forge · session s_1', 'Lint · session s_2']}
                confirmLabel="Disable and stop 2 sessions"
                onConfirm={() => events.push('confirm')}
                onCancel={() => events.push('cancel')}
            />
        );
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.getAttribute('role')).toBe('alertdialog');
        const items = [...popup.querySelectorAll('[data-confirm-dependents] li')].map((li) => li.textContent);
        expect(items).toEqual(['Forge · session s_1', 'Lint · session s_2']);
        const confirm = buttonNamed(popup, 'Disable and stop 2 sessions');
        expect(confirm.getAttribute('data-color')).toBe('error');
        expect(confirm.getAttribute('data-variant')).toBe('solid');
        // The dependents list precedes the destructive button.
        expect(popup.querySelector('[data-confirm-dependents]')!.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The non-destructive button is the dialog's Cancel part (zero's default focus target).
        const cancel = buttonNamed(popup, 'Cancel');
        expect(cancel.getAttribute('data-part')).toBe('cancel');
        confirm.click();
        expect(events).toEqual(['confirm']);
        // The caller closing after a confirm is not a cancel.
        state.open = false;
        await tick();
        expect(events).toEqual(['confirm']);
        state.open = true;
        await tick();
        buttonNamed(root.querySelector('[data-scope="dialog"][data-part="popup"]')!, 'Cancel').click();
        await tick();
        expect(state.open).toBe(false);
        expect(events).toEqual(['confirm', 'cancel']);
    });
});
