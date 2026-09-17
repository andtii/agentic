import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import { Reasoning, aiReasoningAnatomy, reasoningSummary } from '../src/thread';
import { mount, one } from './helpers';

describe('reasoning', () => {
    it('says it is thinking while the part is open with no text — with the token count once one arrives', () => {
        const dom = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: '  ' }} reasoningTokens={120} />);
        expect(one(dom, 'ai-reasoning', 'root')!.getAttribute('data-state')).toBe('open');
        expect(one(dom, 'ai-reasoning', 'summary')!.textContent).toBe('Thinking… 120 tokens');
        expect(one(dom, 'ai-reasoning', 'body')).toBeNull();
        expectAnatomy(dom, aiReasoningAnatomy);
    });

    it('renders nothing once it ended with nothing to show', () => {
        const dom = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: '', done: true }} />);
        expect(one(dom, 'ai-reasoning', 'root')).toBeNull();
    });

    it('shows exposed reasoning open while streaming and folded once done, as "Reasoning · Ns" behind a chevron', () => {
        const live = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: 'weighing INC-41' }} />);
        expect(one(live, 'ai-reasoning', 'root')!.getAttribute('data-state')).toBe('open');
        expect(one(live, 'ai-reasoning', 'body')!.textContent).toContain('weighing INC-41');
        const done = mount(<Reasoning part={{ type: 'reasoning', id: 'r1', text: 'weighing INC-41', done: true }} seconds={6.4} />);
        expect(one(done, 'ai-reasoning', 'root')!.getAttribute('data-state')).toBe('closed');
        expect(one(done, 'ai-reasoning', 'summary')!.textContent).toBe('Reasoning · 6s');
        expect(one(done, 'ai-reasoning', 'summary')!.querySelector('svg')).not.toBeNull();
        expect(reasoningSummary({ type: 'reasoning', id: 'r1', text: 'x', done: true })).toBe('Reasoning');
        expectAnatomy(done, aiReasoningAnatomy);
    });
});
