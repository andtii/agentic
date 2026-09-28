/**
 * The thread's detail levels (#1054, `docs/design/chat-modes/HANDOFF.md` → "Detail levels"): `raw`
 * is today's rendering, `steps` folds each message's tool calls into a steps box, `messages` drops
 * them; both folded levels keep approvals and questions and put the reasoning behind a chip.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import { createTranscript } from '@sigx/ai-agent';
import type { AgentMessage, AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import type { AgentId, TurnSteps } from '@agentic/core';
import { Thread, aiMessageAnatomy, messageSteps, thoughtLabel, type DetailLevel, type StepsMessage } from '../src/thread';
import { mount, one, all, tick } from './helpers';

const tool = (p: Partial<ToolPartState> & Pick<ToolPartState, 'callId'>): ToolPartState => ({ type: 'tool', name: 'Bash', category: 'execute', status: 'completed', input: { command: 'ls' }, output: 'a\nb', ...p });

/** A user prompt, then an agent turn: reasoning, prose, three calls — the last waiting on an approval. */
function transcriptOf(extra: Partial<AgentMessage> = {}): AgentTranscript {
    const t = createTranscript('s1');
    t.requests['r1'] = { requestId: 'r1', kind: 'permission', callId: 'c3', toolName: 'Bash', message: 'Pushes the branch.', seq: 4 };
    t.messages.push(
        { id: 'u1', role: 'user', parts: [{ type: 'text', id: 'u1t', text: 'Make build:ds leaner.' }] },
        {
            id: 'a1',
            role: 'assistant',
            turnId: 't1',
            actor: 'claude',
            parts: [
                { type: 'reasoning', id: 'th', text: 'weighing the static lane', done: true },
                { type: 'text', id: 'p1', text: 'Trying the lean build.' },
                tool({ callId: 'c1', name: 'Read', category: 'read', input: { file_path: 'package.json' } }),
                tool({ callId: 'c2' }),
                tool({ callId: 'c3', status: 'pending', requestId: 'r1', input: { command: 'git push' }, output: undefined })
            ],
            ...extra
        } as AgentMessage
    );
    return t;
}

const noop = (): void => {};
const view = (detail?: DetailLevel, t = transcriptOf()) => mount(<Thread transcript={t} detail={detail} onRespond={noop} describe={() => ({ thoughtSeconds: 6.2 })} />);
const cards = (dom: ParentNode) => all(dom, 'ai-tool-call', 'root');
const approvals = (dom: ParentNode) => all(dom, 'ai-approval', 'root');

describe('Thread detail levels', () => {
    it('raw — the default — renders every tool card and the reasoning block as today', () => {
        for (const dom of [view(), view('raw')]) {
            expect(cards(dom)).toHaveLength(3);
            expect(one(dom, 'ai-steps', 'root')).toBeNull();
            expect(one(dom, 'ai-message', 'thought')).toBeNull();
            expect(one(dom, 'ai-reasoning', 'summary')!.textContent).toBe('Reasoning');
            expect(approvals(dom)).toHaveLength(1);
        }
    });

    it('steps — one steps box per message after its prose, the approval kept', () => {
        const dom = view('steps');
        expect(cards(dom)).toHaveLength(0);
        const boxes = all(dom, 'ai-steps', 'root');
        expect(boxes).toHaveLength(1);
        expect(one(dom, 'ai-steps', 'label')!.textContent).toBe('3 steps · 2 commands, 1 read');
        expect(approvals(dom)).toHaveLength(1);
        // Prose stays; the reasoning is behind the chip.
        expect(all(dom, 'ai-message', 'body')[1]!.textContent).toContain('Trying the lean build.');
        expect(one(dom, 'ai-reasoning', 'root')).toBeNull();
        // The box and the approval sit in the message's tools run, after the body.
        const tools = boxes[0]!.closest('[data-part="tools"]')!;
        expect(tools.contains(approvals(dom)[0]!)).toBe(true);
        expectAnatomy(dom, aiMessageAnatomy);
    });

    it('steps — reads the entry\'s own steps when the message carries them', () => {
        const own: TurnSteps = {
            turnId: 't1',
            total: 12,
            steps: [{ id: 'x', turnId: 't1', agentId: 'claude' as AgentId, kind: 'edit', tool: 'Edit', target: 'a.ts', state: 'done' }]
        };
        const dom = view('steps', transcriptOf({ steps: own } as Partial<StepsMessage>));
        expect(one(dom, 'ai-steps', 'label')!.textContent).toBe('12 steps · 1 edit');
    });

    it('messages — no tool calls at all, the approval kept', () => {
        const dom = view('messages');
        expect(cards(dom)).toHaveLength(0);
        expect(one(dom, 'ai-steps', 'root')).toBeNull();
        expect(approvals(dom)).toHaveLength(1);
        expect(all(dom, 'ai-message', 'body')[1]!.textContent).toContain('Trying the lean build.');
    });

    it('the thought chip opens the reasoning inline, in the meta line', async () => {
        const dom = view('messages');
        const chip = one(dom, 'ai-message', 'thought') as HTMLButtonElement;
        expect(chip.textContent).toBe('thought 6s');
        expect(chip.getAttribute('aria-expanded')).toBe('false');
        chip.click();
        await tick();
        expect(chip.getAttribute('aria-expanded')).toBe('true');
        const thinking = one(dom, 'ai-message', 'thinking')!;
        expect(thinking.textContent).toContain('weighing the static lane');
        expect(thinking.parentElement!.getAttribute('data-part')).toBe('meta');
        chip.click();
        await tick();
        expect(one(dom, 'ai-message', 'thinking')).toBeNull();
    });

    it('keeps the box\'s open state per message when the page holds it', async () => {
        const open = signal<Record<string, boolean>>({});
        const t = transcriptOf();
        const Host = component(() => () => (
            <Thread
                transcript={t}
                detail="steps"
                stepsOpen={(m) => open[m.id]}
                onStepsToggle={(m, o) => {
                    open[m.id] = o;
                }}
            />
        ));
        const dom = mount(<Host />);
        const summary = () => one(dom, 'ai-steps', 'summary') as HTMLButtonElement;
        expect(summary().getAttribute('aria-expanded')).toBe('false');
        summary().click();
        await tick();
        expect(open['a1']).toBe(true);
        expect(summary().getAttribute('aria-expanded')).toBe('true');
    });
});

describe('the detail helpers', () => {
    it('messageSteps: none for a message without calls', () => {
        expect(messageSteps({ id: 'm', role: 'assistant', parts: [{ type: 'text', id: 't', text: 'hi' }] })).toBeUndefined();
    });

    it('thoughtLabel: thinking while open, the time once known', () => {
        expect(thoughtLabel([{ type: 'reasoning', id: 'r', text: '' }])).toBe('thinking…');
        expect(thoughtLabel([{ type: 'reasoning', id: 'r', text: 'x', done: true }])).toBe('thought');
        expect(thoughtLabel([{ type: 'reasoning', id: 'r', text: 'x', done: true }], 6.4)).toBe('thought 6s');
    });
});
