/**
 * A message the thread window splits over several rows (`from`/`to`, #1088): the thought chip and
 * its reasoning speak for the whole message, so only the row holding the first part carries them.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@sigx/ai-agent/app';
import { Message } from '../src/thread';
import { mount, all, one, tick } from './helpers';

const message: AgentMessage = {
    id: 'a1',
    role: 'assistant',
    actor: 'claude',
    parts: [
        { type: 'reasoning', id: 'th', text: 'weighing the static lane', done: true },
        { type: 'text', id: 'p1', text: 'Trying the lean build.' },
        { type: 'text', id: 'p2', text: 'It builds.' },
        { type: 'reasoning', id: 'th2', text: 'checking the size budget', done: true },
        { type: 'text', id: 'p3', text: 'Within budget.' }
    ]
} as AgentMessage;

describe('Message split across rows', () => {
    it('shows the thought chip once, on the row holding the first part', async () => {
        const dom = mount(
            <div>
                <Message message={message} detail="messages" author={{ name: 'Claude', thoughtSeconds: 6.2 }} from={0} to={2} />
                <Message message={message} detail="messages" author={{ name: 'Claude', thoughtSeconds: 6.2 }} from={2} to={5} />
            </div>
        );
        const rows = all(dom, 'ai-message', 'root');
        expect(rows).toHaveLength(2);
        expect(all(dom, 'ai-message', 'thought')).toHaveLength(1);
        const chip = one(rows[0]!, 'ai-message', 'thought') as HTMLButtonElement;
        expect(chip.textContent).toBe('thought 6s');
        expect(one(rows[1]!, 'ai-message', 'thought')).toBeNull();
        // Open, the chip shows every reasoning part of the message, once.
        chip.click();
        await tick();
        const thinking = all(dom, 'ai-message', 'thinking');
        expect(thinking).toHaveLength(1);
        expect(thinking[0]!.textContent).toContain('weighing the static lane');
        expect(thinking[0]!.textContent).toContain('checking the size budget');
        // Each row keeps its own slice of the prose.
        expect(rows[0]!.textContent).toContain('Trying the lean build.');
        expect(rows[1]!.textContent).toContain('Within budget.');
        expect(rows[1]!.textContent).not.toContain('Trying the lean build.');
    });

    it('an unsplit message still carries its chip', () => {
        const dom = mount(<Message message={message} detail="messages" author={{ name: 'Claude' }} />);
        expect(all(dom, 'ai-message', 'thought')).toHaveLength(1);
    });
});
