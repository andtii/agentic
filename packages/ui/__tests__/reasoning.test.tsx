import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import type { ReasoningPartState } from '@sigx/ai-agent/app';
import { Reasoning, aiReasoningAnatomy, reasoningSummary } from '../src/thread';
import { mount, one, tick } from './helpers';

/** The block's disclosure: zero's Collapsible, a native `<details>`. */
const details = (root: ParentNode): HTMLDetailsElement => one(root, 'ai-reasoning', 'root')!.querySelector<HTMLDetailsElement>('details[data-scope="collapsible"][data-part="root"]')!;
const trigger = (root: ParentNode): HTMLElement => one(root, 'ai-reasoning', 'root')!.querySelector<HTMLElement>('summary[data-scope="collapsible"][data-part="trigger"]')!;

describe('reasoning', () => {
    it('says it is thinking while the part is open with no text — with the token count once one arrives', () => {
        const dom = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: '  ' }} reasoningTokens={120} />);
        expect(details(dom).open).toBe(true);
        expect(details(dom).getAttribute('data-state')).toBe('open');
        expect(one(dom, 'ai-reasoning', 'summary')!.textContent).toBe('Thinking… 120 tokens');
        expect(trigger(dom).contains(one(dom, 'ai-reasoning', 'summary'))).toBe(true);
        expect(one(dom, 'ai-reasoning', 'body')).toBeNull();
        expectAnatomy(dom, aiReasoningAnatomy);
    });

    it('renders nothing once it ended with nothing to show', () => {
        const dom = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: '', done: true }} />);
        expect(one(dom, 'ai-reasoning', 'root')).toBeNull();
    });

    it('shows exposed reasoning open while streaming and folded once done, as "Reasoning · Ns" on a zero Collapsible', () => {
        const live = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: 'weighing INC-41' }} />);
        expect(details(live).open).toBe(true);
        expect(one(live, 'ai-reasoning', 'body')!.textContent).toContain('weighing INC-41');
        expect(one(live, 'ai-reasoning', 'body')!.closest('[data-scope="collapsible"][data-part="panel"]')).not.toBeNull();
        const done = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: 'weighing INC-41', done: true }} seconds={6.4} />);
        expect(details(done).open).toBe(false);
        expect(details(done).getAttribute('data-state')).toBe('closed');
        expect(one(done, 'ai-reasoning', 'summary')!.textContent).toBe('Reasoning · 6s');
        expect(reasoningSummary({ type: 'reasoning', id: 'r1', text: 'x', done: true })).toBe('Reasoning');
        expectAnatomy(done, aiReasoningAnatomy);
    });

    it('follows the part until the reader toggles it — then the reader wins across streaming updates', async () => {
        const st = signal<{ part: ReasoningPartState }>({ part: { type: 'reasoning', id: 'r1', text: 'weighing' } });
        const Host = component(() => () => <Reasoning part={st.part} />);
        const dom = mount(<Host />);
        expect(details(dom).open).toBe(true);
        // Untouched, it folds once the part is done.
        st.part = { type: 'reasoning', id: 'r1', text: 'weighing INC-41', done: true };
        await tick();
        expect(details(dom).open).toBe(false);

        // A second block: the reader folds it while it streams, and more text does not re-open it.
        const live = signal<{ part: ReasoningPartState }>({ part: { type: 'reasoning', id: 'r2', text: 'first' } });
        const Live = component(() => () => <Reasoning part={live.part} />);
        const other = mount(<Live />);
        trigger(other).click();
        await tick();
        expect(details(other).open).toBe(false);
        live.part = { type: 'reasoning', id: 'r2', text: 'first, then second' };
        await tick();
        expect(details(other).open).toBe(false);
        expect(one(other, 'ai-reasoning', 'body')!.textContent).toContain('then second');
        // And opened again by hand, finishing does not fold it.
        trigger(other).click();
        await tick();
        live.part = { type: 'reasoning', id: 'r2', text: 'first, then second', done: true };
        await tick();
        expect(details(other).open).toBe(true);
    });
});
