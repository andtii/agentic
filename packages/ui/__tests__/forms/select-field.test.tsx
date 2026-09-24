/**
 * SelectField's `virtual` passthrough: a few hundred time zones render a
 * window of options while open, and the posted value is still the model's.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/reactivity';
import { virtualListbox } from '@sigx/zero/virtual-listbox';
import { SelectField } from '@agentic/ui';
import { mount, settle } from './helpers';

const ZONES = Array.from({ length: 420 }, (_, i) => `Region${Math.floor(i / 60)}/City${i}`);

function open(root: HTMLElement): HTMLElement {
    const trigger = root.querySelector<HTMLElement>('[data-scope="select"][data-part="trigger"]')!;
    trigger.click();
    return root.querySelector<HTMLElement>('[data-scope="select"][data-part="content"]') ?? document.body;
}

describe('SelectField virtual', () => {
    it('windows a long list: fewer than 60 options in the DOM while open', async () => {
        const state = signal({ zone: 'Region0/City3' });
        const root = mount(<SelectField name="time-zone" label="Time zone" model={() => state.zone} options={ZONES.map((z) => ({ value: z, label: z }))} virtual={virtualListbox} estimateItemSize={36} />);
        await settle();
        open(root);
        await settle();
        const rendered = document.querySelectorAll('[data-scope="select"][data-part="item"]').length;
        expect(rendered).toBeGreaterThan(0);
        expect(rendered).toBeLessThan(60);
        // The hidden select still posts the chosen zone.
        const hidden = root.querySelector<HTMLSelectElement>('select[name="time-zone"]')!;
        expect(hidden.value).toBe('Region0/City3');
    });

    it('without virtual renders every option', async () => {
        const state = signal({ zone: '' });
        const root = mount(<SelectField name="tz" label="Time zone" model={() => state.zone} options={ZONES.slice(0, 80).map((z) => ({ value: z, label: z }))} />);
        await settle();
        open(root);
        await settle();
        expect(root.querySelectorAll('[data-scope="select"][data-part="item"]').length).toBe(80);
    });
});
