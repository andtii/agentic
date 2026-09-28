/**
 * The steps box, the step line, the failure excerpt and the live line (#1054) — every row of the
 * TranscriptParts board (`docs/design/chat-modes/HANDOFF.md` → "Parts and rules"): the five step
 * states, the three summary states (collapsed, failed and recovered, failed and not recovered),
 * the excerpt, and the box's open state both uncontrolled and controlled.
 */
import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/reactivity';
import { component } from '@sigx/runtime-core';
import { createTranscript } from '@sigx/ai-agent';
import type { AgentMessage, ToolPartState } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import type { AgentId, TranscriptStep, TurnSteps } from '@agentic/core';
import { Steps, LiveLine, aiStepsAnatomy, aiLiveLineAnatomy, stepsFromToolParts, formatStepDuration, stepDuration, formatElapsed } from '../src/transcript';
import { recipes } from '../src/fragment/recipes';
import { SCOPES } from '../src/fragment';
import { mount, one, all, buttonNamed, tick } from './helpers';

const agent = 'claude' as AgentId;
const step = (p: Partial<TranscriptStep> & Pick<TranscriptStep, 'id'>): TranscriptStep => ({
    turnId: 't1',
    agentId: agent,
    kind: 'command',
    tool: 'Bash',
    target: 'npx sigx zero:build',
    state: 'done',
    ...p
});
const turn = (steps: TranscriptStep[], extra: Partial<TurnSteps> = {}): TurnSteps => ({ turnId: 't1', steps, total: steps.length, ...extra });

const summary = (root: ParentNode): HTMLButtonElement => one(root, 'ai-steps', 'summary') as HTMLButtonElement;
const label = (root: ParentNode): string => one(root, 'ai-steps', 'label')!.textContent!;
const lines = (root: ParentNode): HTMLElement[] => all(root, 'ai-steps', 'step');

/** The board's step line states. */
const BOARD: TranscriptStep[] = [
    step({ id: 's1', kind: 'read', tool: 'Read', target: 'packages/ui/package.json', startedAt: 0, endedAt: 100 }),
    step({ id: 's2', state: 'running', startedAt: 1000 }),
    step({ id: 's3', state: 'error', target: 'npx sigx zero:fragment --strict', startedAt: 0, endedAt: 2400, exitCode: 1, output: { lines: 14, excerpt: ['[sigx] ERROR: the package root could not be read', "Cannot find module '@agentic/core/dist/index.js'"], picked: 'error', ref: 's3' } }),
    step({ id: 's4', state: 'pending', target: 'git push origin 608-real-register' }),
    step({ id: 's5', kind: 'edit', tool: 'Edit', target: 'package.json · build:ds', result: '+3 −2', startedAt: 0, endedAt: 200 }),
    step({ id: 's6', state: 'denied', target: 'npm test (skipped: cancelled)' })
];

describe('Steps', () => {
    it('renders every step state of the board on the governed lifecycle, one line each', () => {
        const dom = mount(<Steps steps={turn(BOARD)} open now={5000} fullHref={(s) => `/session#${s.id}`} />);
        expectAnatomy(dom, aiStepsAnatomy);
        const got = lines(dom).map((l) => [
            l.getAttribute('data-state'),
            one(l, 'ai-steps', 'icon')!.getAttribute('aria-label'),
            one(l, 'ai-steps', 'tool')!.textContent,
            one(l, 'ai-steps', 'result')!.textContent,
            one(l, 'ai-steps', 'duration')!.textContent
        ]);
        expect(got).toEqual([
            ['complete', 'done', 'Read', '', '0.1s'],
            ['running', 'running', 'Bash', '', '4s'],
            ['error', 'failed', 'Bash', '', '2.4s'],
            ['loading', 'needs approval', 'Bash', 'needs approval', 'waits'],
            ['complete', 'done', 'Edit', '+3 −2', '0.2s'],
            ['denied', 'denied or skipped', 'Bash', '', '—']
        ]);
        // A running step turns a ring; the rest show an icon.
        expect(one(lines(dom)[1]!, 'ai-steps', 'icon')!.querySelector('i')).not.toBeNull();
        expect(one(lines(dom)[0]!, 'ai-steps', 'icon')!.querySelector('svg')).not.toBeNull();
        expect(one(lines(dom)[2]!, 'ai-steps', 'target')!.getAttribute('title')).toBe('npx sigx zero:fragment --strict');
    });

    it('shows a failed step its excerpt: the picked lines, the note and Full output', () => {
        const dom = mount(<Steps steps={turn(BOARD)} open fullHref={(s) => `/session#${s.id}`} />);
        const excerpts = all(dom, 'ai-steps', 'excerpt');
        expect(excerpts).toHaveLength(1);
        const excerpt = excerpts[0]!;
        expect(excerpt.closest('[data-part="step"]')!.getAttribute('data-state')).toBe('error');
        expect([...excerpt.querySelectorAll(':scope > div:not([data-part])')].map((d) => d.textContent)).toEqual([
            '[sigx] ERROR: the package root could not be read',
            "Cannot find module '@agentic/core/dist/index.js'"
        ]);
        expect(one(excerpt, 'ai-steps', 'excerpt-meta')!.firstElementChild!.textContent).toBe('exit 1 · 2 of 14 lines, picked by error');
        const full = one(excerpt, 'ai-steps', 'full') as HTMLAnchorElement;
        expect(full.textContent).toBe('Full output');
        expect(full.getAttribute('href')).toBe('/session#s3');
    });

    it('drops the Full output link without a href, and the excerpt for a failed step with no output', () => {
        const dom = mount(<Steps steps={turn([step({ id: 'a', state: 'error', output: { lines: 3, excerpt: ['x'], picked: 'tail', ref: 'a' } }), step({ id: 'b', state: 'error' })])} open />);
        expect(all(dom, 'ai-steps', 'excerpt')).toHaveLength(1);
        expect(one(dom, 'ai-steps', 'full')).toBeNull();
        expect(one(dom, 'ai-steps', 'excerpt-meta')!.textContent).toBe('1 of 3 lines, picked by tail');
    });

    it('collapsed: a finished turn stays shut and says what it did and how long it took', () => {
        const steps = [
            ...Array.from({ length: 5 }, (_, i) => step({ id: `c${i}` })),
            step({ id: 'r1', kind: 'read', tool: 'Read' }),
            step({ id: 'r2', kind: 'read', tool: 'Read' }),
            step({ id: 'e1', kind: 'edit', tool: 'Edit' })
        ];
        const dom = mount(<Steps steps={turn(steps, { startedAt: 0, endedAt: 72_000 })} />);
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
        expect(label(dom)).toBe('8 steps · 5 commands, 2 reads, 1 edit');
        expect(one(dom, 'ai-steps', 'total')!.textContent).toBe('1m 12s');
        expect(one(dom, 'ai-steps', 'list')).toBeNull();
        expectAnatomy(dom, aiStepsAnatomy);
    });

    it('failed and recovered: the failure is named, the box stays shut', () => {
        const steps = [
            step({ id: 'a', state: 'error', target: 'pnpm build' }),
            step({ id: 'b', target: 'pnpm build' }),
            step({ id: 'c' }),
            step({ id: 'r1', kind: 'read', tool: 'Read' }),
            step({ id: 'r2', kind: 'read', tool: 'Read' })
        ];
        const dom = mount(<Steps steps={turn(steps, { startedAt: 0, endedAt: 18_000 })} />);
        expect(label(dom)).toBe('5 steps · 3 commands, 2 reads · 1 failed, recovered');
        expect(one(dom, 'ai-steps', 'total')!.textContent).toBe('18s');
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
    });

    it('failed, not recovered: the box opens itself', () => {
        const steps = [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c', state: 'error', target: 'npx sigx zero:fragment --strict', output: { lines: 14, excerpt: ['ERROR'], picked: 'error', ref: 'c' }, exitCode: 1 })];
        const dom = mount(<Steps steps={turn(steps, { startedAt: 0, endedAt: 6000 })} />);
        expect(label(dom)).toBe('3 steps · 3 commands · 1 failed');
        expect(summary(dom).getAttribute('aria-expanded')).toBe('true');
        expect(lines(dom)).toHaveLength(3);
        expect(summary(dom).getAttribute('aria-controls')).toBe(one(dom, 'ai-steps', 'list')!.id);
    });

    it('uncontrolled: the reader toggles it, and the toggle wins over a later failure', async () => {
        const st = signal<{ steps: TurnSteps }>({ steps: turn([step({ id: 'a' })]) });
        const toggles: boolean[] = [];
        const Host = component(() => () => <Steps steps={st.steps} onToggle={(o) => toggles.push(o)} />);
        const dom = mount(<Host />);
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
        // Untouched, a failure that stops the work opens it.
        st.steps = turn([step({ id: 'a', state: 'error' })]);
        await tick();
        expect(summary(dom).getAttribute('aria-expanded')).toBe('true');
        summary(dom).click();
        await tick();
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
        expect(toggles).toEqual([false]);
        st.steps = turn([step({ id: 'a', state: 'error' }), step({ id: 'b', state: 'error' })]);
        await tick();
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
    });

    it('controlled: shows `open` and asks onToggle for the change', async () => {
        const st = signal({ open: false });
        const asked: boolean[] = [];
        const Host = component(() => () => (
            <Steps
                steps={turn([step({ id: 'a', state: 'error' })])}
                open={st.open}
                onToggle={(o) => {
                    asked.push(o);
                }}
            />
        ));
        const dom = mount(<Host />);
        // A stopped turn would open itself, but the page said shut.
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
        summary(dom).click();
        await tick();
        expect(asked).toEqual([true]);
        expect(summary(dom).getAttribute('aria-expanded')).toBe('false');
        st.open = true;
        await tick();
        expect(summary(dom).getAttribute('aria-expanded')).toBe('true');
        expect(lines(dom)).toHaveLength(1);
    });
});

describe('the step helpers', () => {
    it('formats durations as the board prints them', () => {
        expect(formatStepDuration(100)).toBe('0.1s');
        expect(formatStepDuration(2400)).toBe('2.4s');
        expect(formatStepDuration(18_000)).toBe('18s');
        expect(formatStepDuration(72_000)).toBe('1m 12s');
        expect(formatStepDuration(3_780_000)).toBe('1h 3m');
        expect(stepDuration(step({ id: 'x' }))).toBe('');
        expect(formatElapsed(6400)).toBe('6s');
        expect(formatElapsed(72_000)).toBe('1m 12s');
    });

    it('reads a turn in flight off its tool parts', () => {
        const transcript = createTranscript('s1');
        transcript.requests['r1'] = { requestId: 'r1', kind: 'permission', callId: 'c4', toolName: 'Bash', seq: 1 };
        const tool = (p: Partial<ToolPartState> & Pick<ToolPartState, 'callId'>): ToolPartState => ({ type: 'tool', name: 'Bash', category: 'execute', status: 'completed', input: { command: 'ls' }, ...p });
        const message: AgentMessage = {
            id: 'm1',
            role: 'assistant',
            turnId: 't9',
            actor: 'claude',
            parts: [
                { type: 'text', id: 'x', text: 'on it' },
                tool({ callId: 'c1', name: 'Read', category: 'read', input: { file_path: 'a.ts' } }),
                tool({ callId: 'c2', status: 'in_progress' }),
                tool({ callId: 'c3', status: 'failed', error: 'line 1\nError: boom\nline 3' }),
                tool({ callId: 'c4', status: 'pending', requestId: 'r1' }),
                tool({ callId: 'c5', status: 'cancelled' }),
                tool({ callId: 'c6', status: 'streaming', inputText: '{"command":"np' })
            ]
        };
        const steps = stepsFromToolParts(message, transcript);
        expect(steps.turnId).toBe('t9');
        expect(steps.total).toBe(6);
        expect(steps.steps.map((s) => [s.id, s.kind, s.tool, s.target, s.state])).toEqual([
            ['c1', 'read', 'Read', 'a.ts', 'done'],
            ['c2', 'command', 'Bash', 'ls', 'running'],
            ['c3', 'command', 'Bash', 'ls', 'error'],
            ['c4', 'command', 'Bash', 'ls', 'pending'],
            ['c5', 'command', 'Bash', 'ls', 'denied'],
            ['c6', 'command', 'Bash', '{"command":"np', 'running']
        ]);
        expect(steps.steps[2]!.output).toEqual({ lines: 3, excerpt: ['line 1', 'Error: boom'], picked: 'error', ref: 'c3' });
        expect(steps.steps[0]!.agentId).toBe('claude');
    });
});

describe('LiveLine', () => {
    it('is the 44 px row: spinner, agent, current step, elapsed and Stop', () => {
        let stopped = 0;
        const dom = mount(<LiveLine agent="Claude Code" step="Edit · packages/ui/package.json" startedAt={Date.now() - 6400} onStop={() => stopped++} />);
        expectAnatomy(dom, aiLiveLineAnatomy);
        expect(one(dom, 'ai-live-line', 'agent')!.textContent).toContain('Claude Code');
        expect(one(dom, 'ai-live-line', 'step')!.textContent).toBe('Edit · packages/ui/package.json');
        expect(one(dom, 'ai-live-line', 'elapsed')!.textContent).toBe('6s');
        buttonNamed(dom, 'Stop').click();
        expect(stopped).toBe(1);
    });

    it('offers no Stop without onStop', () => {
        const dom = mount(<LiveLine agent="Forge" startedAt={Date.now()} />);
        expect(one(dom, 'ai-live-line', 'stop')).toBeNull();
        expect(one(dom, 'ai-live-line', 'step')!.textContent).toBe('working');
    });
});

describe('the recipes', () => {
    it('style both scopes, and the fragment declares them', () => {
        const byScope = new Map(recipes.map((r) => [r.component, r]));
        expect(Object.keys(byScope.get('ai-steps')!.parts!)).toEqual(expect.arrayContaining(aiStepsAnatomy.toJSON().parts.map((p) => p.name)));
        expect(Object.keys(byScope.get('ai-live-line')!.parts!)).toEqual(expect.arrayContaining(aiLiveLineAnatomy.toJSON().parts.map((p) => p.name)));
        expect(byScope.get('ai-steps')!.parts!.step!.base).toMatchObject({ gridTemplateColumns: '16px 46px minmax(0, 1fr) auto 44px' });
        expect(SCOPES).toEqual(expect.arrayContaining(['ai-steps', 'ai-live-line']));
    });
});
