import { signal } from '@sigx/reactivity';
import { NOTIFICATION_KINDS } from '@agentic/core';
import { SettingsForm, SETTINGS_FIELDS as F, defaultSettingsFormValue, fromSettingsDraft, parseSettingsFormData, settingsDraftFromFormData, supportedTimeZones, toSettingsDraft, validateSettingsDraft, type SettingsErrors, type SettingsFormApi, type SettingsFormValue } from '@agentic/ui';
import { controls, describedByRole, fullSettings, labelOf, mount, setText, submit, toggle } from './helpers';

const zones = ['Europe/Stockholm', 'Europe/London', 'America/New_York', 'UTC'];

function mountForm(settings: SettingsFormValue = fullSettings()) {
    const state = signal({ settings });
    const ref = { current: null as SettingsFormApi | null };
    const submitted: SettingsFormValue[] = [];
    const invalid: SettingsErrors[] = [];
    const root = mount(<SettingsForm model={() => state.settings} ref={ref} timeZones={zones} environments={[{ value: 'env_1', label: 'Laptop' }]} onSubmit={(s) => submitted.push(s)} onInvalid={(e) => invalid.push(e)} />);
    const form = root.querySelector('form')!;
    return { state, root, form, api: () => ref.current!, submitted, invalid };
}

describe('settings model', () => {
    it('defaults enable exactly the core notification kinds', () => {
        expect(Object.keys(defaultSettingsFormValue().notifications.kinds)).toEqual([...NOTIFICATION_KINDS]);
        expect(Object.values(defaultSettingsFormValue().notifications.kinds).every(Boolean)).toBe(true);
    });

    it('round-trips through the draft and through FormData', () => {
        const s = fullSettings();
        expect(fromSettingsDraft(toSettingsDraft(s))).toEqual(s);
        const fd = new FormData();
        fd.set(F.timeZone, s.timeZone);
        fd.set(F.notify('reminder'), 'on');
        fd.set(F.notify('task-failed'), 'on');
        fd.set(F.notify('approval'), 'on');
        fd.set(F.push, 'on');
        fd.set(F.environment, 'env_1');
        expect(fromSettingsDraft(settingsDraftFromFormData(fd))).toEqual(s);
        expect(parseSettingsFormData(fd, zones)).toEqual({ settings: s, errors: {} });
    });

    it('validates the zone against the known list, accepting UTC and anything when nothing is known', () => {
        const d = toSettingsDraft(fullSettings());
        expect(validateSettingsDraft(d, zones)).toEqual({});
        expect(validateSettingsDraft({ ...d, timeZone: 'Mars/Olympus' }, zones).timeZone).toMatch(/Unknown/);
        expect(validateSettingsDraft({ ...d, timeZone: '' }, zones).timeZone).toMatch(/Choose/);
        expect(validateSettingsDraft({ ...d, timeZone: 'UTC' }, ['Europe/Oslo'])).toEqual({});
        expect(validateSettingsDraft({ ...d, timeZone: 'Mars/Olympus' }, [])).toEqual({});
        expect(Array.isArray(supportedTimeZones())).toBe(true);
    });
});

describe('SettingsForm', () => {
    it('labels every control and posts a FormData that reads back to the model', () => {
        const { root, form, state } = mountForm();
        for (const el of controls(root)) expect(labelOf(el), `${el.getAttribute('name')} has a label`).not.toBe('');
        expect(fromSettingsDraft(settingsDraftFromFormData(new FormData(form)))).toEqual(state.settings);
    });

    it('edits bind through the model and a valid submit writes back', () => {
        const { root, form, state, submitted } = mountForm();
        toggle(root.querySelector<HTMLInputElement>(`input[name="${F.notify('task-done')}"]`)!, true);
        toggle(root.querySelector<HTMLInputElement>(`input[name="${F.push}"]`)!, false);
        const tz = root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
        setText(tz, 'london');
        const items = [...root.querySelectorAll<HTMLElement>('[data-scope="combobox"][data-part="item"]')];
        // the chosen zone stays listed (and selected); the item's check indicator is aria-hidden, not part of its text
        const itemText = (i: HTMLElement) => [...i.childNodes].filter((n) => !(n instanceof HTMLElement && n.dataset.part === 'item-indicator')).map((n) => n.textContent).join('');
        expect(items.map(itemText)).toEqual(['Europe/London', 'Europe/Stockholm']);
        expect(items[1]!.getAttribute('aria-selected')).toBe('true');
        items[0]!.click();
        submit(form);
        expect(submitted).toHaveLength(1);
        expect(state.settings).toEqual({
            timeZone: 'Europe/London',
            notifications: { kinds: { reminder: true, 'task-done': true, 'task-failed': true, approval: true, input: false }, push: false },
            defaultEnvironmentId: 'env_1'
        });
        expect(fromSettingsDraft(settingsDraftFromFormData(new FormData(form)))).toEqual(state.settings);
    });

    it('blocks an unknown zone with an accessible error and reset() restores', () => {
        const { root, form, state, api, submitted, invalid } = mountForm();
        api().draft.timeZone = 'Mars/Olympus';
        submit(form);
        expect(submitted).toHaveLength(0);
        expect(invalid[0]!.timeZone).toMatch(/Unknown/);
        const tz = root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
        expect(tz.getAttribute('aria-invalid')).toBe('true');
        expect(describedByRole(tz, 'alert')[0]!.textContent).toMatch(/Unknown/);
        expect(state.settings.timeZone).toBe('Europe/Stockholm');

        api().reset();
        expect(api().draft.timeZone).toBe('Europe/Stockholm');
        expect(describedByRole(tz, 'alert')).toHaveLength(0);
    });

    it('starts from the defaults without a model', () => {
        const root = mount(<SettingsForm timeZones={zones} />);
        expect(new FormData(root.querySelector('form')!).get(F.timeZone)).toBe('UTC');
    });
});
