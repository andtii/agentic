/**
 * The team parts (#1057) — every state drawn on the ChatTeam and ChatLanes boards
 * (`docs/design/chat-modes/HANDOFF.md` → "Team", "Lanes"): the crew strip's four members (idle,
 * working and followed, done, waiting on you), the handoff line, the work card working and done,
 * folded talk, the three lanes (working, done, asking) and the follow panel.
 */
import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import type { AgentId, TranscriptStep } from '@agentic/core';
import {
    CrewStrip,
    HandoffLine,
    WorkCard,
    FoldedTalk,
    Lane,
    FollowPanel,
    aiCrewAnatomy,
    aiHandoffAnatomy,
    aiWorkCardAnatomy,
    aiFoldedTalkAnatomy,
    aiLaneAnatomy,
    aiFollowAnatomy,
    teamAnatomies,
    crewLifecycle,
    elapsedOf,
    formatWorkMeta,
    formatFoldedTalk,
    CREW_STATES,
    type CrewMember
} from '../src/team';
import { recipes } from '../src/fragment/recipes';
import { SCOPES } from '../src/fragment';
import * as root from '../src';
import { mount, one, all, buttonNamed } from './helpers';

const NOW = 1_000_000;
const step = (p: Partial<TranscriptStep> & Pick<TranscriptStep, 'id'>): TranscriptStep => ({
    turnId: 't1',
    agentId: 'forge' as AgentId,
    kind: 'command',
    tool: 'Bash',
    target: 'npx vite build',
    state: 'done',
    startedAt: 0,
    endedAt: 1900,
    ...p
});
const FORGE_STEPS: TranscriptStep[] = [
    step({ id: 's1', kind: 'read', tool: 'Read', target: 'packages/ui/package.json', endedAt: 100 }),
    step({ id: 's2', kind: 'edit', tool: 'Edit', target: 'package.json · build:ds', result: '+3 −2', endedAt: 200 }),
    step({ id: 's3' }),
    step({ id: 's4', state: 'error', target: 'npx sigx zero:fragment --strict', result: 'needs @agentic/core built', endedAt: 2400 }),
    step({ id: 's5', state: 'running', target: 'npx sigx zero:build ./dist/design-system.js --out dist/ds', startedAt: NOW - 4000, endedAt: undefined })
];

const CREW: CrewMember[] = [
    { id: 'atlas', name: 'Atlas', hue: 1, state: 'idle', step: 'waiting on Forge and Lint' },
    { id: 'forge', name: 'Forge', hue: 2, state: 'working', startedAt: NOW - 252_000, step: 'Bash · npx sigx zero:build' },
    { id: 'lint', name: 'Lint', hue: 3, state: 'done', startedAt: 0, endedAt: 100_000, step: 'done · fragments pass' },
    { id: 'scout', name: 'Scout', hue: 4, state: 'needs-you', startedAt: NOW - 360_000, step: 'Read · docs', ask: 'which bundler?' }
];

describe('the team model', () => {
    it('maps every member state onto a distinct governed lifecycle value', () => {
        expect(CREW_STATES.map(crewLifecycle)).toEqual(['running', 'loading', 'paused', 'complete', 'error']);
    });

    it('prints the times and counts the boards show', () => {
        expect(elapsedOf(undefined, undefined, NOW)).toBe('–');
        expect(elapsedOf(NOW - 252_000, undefined, NOW)).toBe('4m 12s');
        expect(elapsedOf(0, 100_000, NOW)).toBe('1m 40s');
        expect(formatWorkMeta(23, '4m 12s')).toBe('23 steps · 4m 12s');
        expect(formatWorkMeta(1)).toBe('1 step');
        expect(formatFoldedTalk(['Forge', 'Lint'], 4)).toBe('Forge and Lint exchanged 4 messages');
        expect(formatFoldedTalk(['Forge', 'Lint', 'Scout'], 1)).toBe('Forge, Lint and Scout exchanged 1 message');
    });
});

describe('CrewStrip', () => {
    it('draws one chip per member in the board\'s states, the followed one selected', () => {
        const dom = mount(<CrewStrip members={CREW} selected="forge" now={NOW} />);
        expectAnatomy(dom, aiCrewAnatomy);
        const chips = all(dom, 'ai-crew', 'chip');
        expect(chips.map((c) => c.getAttribute('data-state'))).toEqual(['paused', 'running', 'complete', 'loading']);
        expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
        expect(chips[1]!.hasAttribute('data-selected')).toBe(true);
        expect(chips[0]!.hasAttribute('data-selected')).toBe(false);
        expect(chips.map((c) => one(c, 'ai-crew', 'elapsed')!.textContent)).toEqual(['–', '4m 12s', '1m 40s', '6m 0s']);
        // A turning ring while working, a dot otherwise.
        expect(one(chips[1]!, 'ai-crew', 'mark')!.querySelector('i')).not.toBeNull();
        expect(one(chips[2]!, 'ai-crew', 'mark')!.querySelector('b')).not.toBeNull();
        expect(one(chips[1]!, 'ai-crew', 'step')!.textContent).toBe('Bash · npx sigx zero:build');
        // Waiting on you: the second line is the question, not the step.
        expect(one(chips[3]!, 'ai-crew', 'step')).toBeNull();
        expect(one(chips[3]!, 'ai-crew', 'ask')!.textContent).toBe('asks you: which bundler?');
    });

    it('emits follow with the member\'s id when a chip is clicked', () => {
        const followed: string[] = [];
        const dom = mount(<CrewStrip members={CREW} now={NOW} onFollow={(id) => followed.push(id)} />);
        all(dom, 'ai-crew', 'chip')[3]!.click();
        all(dom, 'ai-crew', 'chip')[1]!.click();
        expect(followed).toEqual(['scout', 'forge']);
    });
});

describe('HandoffLine', () => {
    it('is the send icon, sender, chevron, receiver, task and item ref', () => {
        const dom = mount(<HandoffLine from={{ name: 'Atlas', hue: 1 }} to={{ name: 'Forge', hue: 2 }} task="Real register build" itemRef="#21" />);
        expectAnatomy(dom, aiHandoffAnatomy);
        expect(one(dom, 'ai-handoff', 'from')!.textContent).toContain('Atlas');
        expect(one(dom, 'ai-handoff', 'to')!.textContent).toContain('Forge');
        expect(one(dom, 'ai-handoff', 'task')!.textContent).toBe('Real register build');
        expect(one(dom, 'ai-handoff', 'ref')!.textContent).toBe('#21');
    });

    it('drops the ref chip without an item', () => {
        const dom = mount(<HandoffLine from={{ name: 'Atlas' }} to={{ name: 'Scout' }} task="Can the static lane drop vite?" />);
        expect(one(dom, 'ai-handoff', 'ref')).toBeNull();
    });
});

describe('WorkCard', () => {
    it('working: a ring, the count and time, the last 3 steps as step lines, Following', () => {
        let follows = 0;
        const dom = mount(
            <WorkCard agent={{ name: 'Forge', hue: 2 }} state="working" task="Real register build · #21" steps={FORGE_STEPS} stepCount={23} startedAt={NOW - 252_000} now={NOW} following onFollow={() => follows++} />
        );
        expectAnatomy(dom, aiWorkCardAnatomy);
        const card = one(dom, 'ai-work-card', 'root')!;
        expect(card.getAttribute('data-state')).toBe('running');
        expect(one(dom, 'ai-work-card', 'mark')!.querySelector('i')).not.toBeNull();
        expect(one(dom, 'ai-work-card', 'meta')!.textContent).toBe('23 steps · 4m 12s');
        const lines = all(dom, 'ai-steps', 'step');
        expect(lines.map((l) => [l.getAttribute('data-state'), one(l, 'ai-steps', 'target')!.textContent])).toEqual([
            ['complete', 'npx vite build'],
            ['error', 'npx sigx zero:fragment --strict'],
            ['running', 'npx sigx zero:build ./dist/design-system.js --out dist/ds']
        ]);
        expect(one(dom, 'ai-work-card', 'result')).toBeNull();
        buttonNamed(dom, 'Following').click();
        expect(follows).toBe(1);
    });

    it('done: a check, the result as prose instead of steps, Follow', () => {
        const dom = mount(
            <WorkCard
                agent={{ name: 'Lint', hue: 3 }}
                state="done"
                task="Check fragments · #22"
                steps={FORGE_STEPS.slice(0, 3)}
                stepCount={9}
                startedAt={0}
                endedAt={100_000}
                result="Fragments pass the strict check with Forge's change: 34 scopes, 0 errors. Nothing for you to do."
                onFollow={() => {}}
            />
        );
        expect(one(dom, 'ai-work-card', 'root')!.getAttribute('data-state')).toBe('complete');
        expect(one(dom, 'ai-work-card', 'mark')!.querySelector('svg[data-icon="check"]')).not.toBeNull();
        expect(one(dom, 'ai-work-card', 'meta')!.textContent).toBe('9 steps · 1m 40s');
        expect(one(dom, 'ai-work-card', 'result')!.textContent).toContain('34 scopes, 0 errors');
        expect(all(dom, 'ai-steps', 'step')).toHaveLength(0);
        expect(buttonNamed(dom, 'Follow')).toBeTruthy();
    });

    it('offers no Follow without onFollow', () => {
        const dom = mount(<WorkCard agent={{ name: 'Forge' }} state="working" task="Build" />);
        expect(one(dom, 'ai-work-card', 'follow')).toBeNull();
        expect(one(dom, 'ai-work-card', 'meta')!.textContent).toBe('0 steps');
    });
});

describe('FoldedTalk', () => {
    it('is the centred divider, and asks to show and to hide', () => {
        const asked: boolean[] = [];
        const dom = mount(<FoldedTalk names={['Forge', 'Lint']} count={4} onToggle={(o) => asked.push(o)} />);
        expectAnatomy(dom, aiFoldedTalkAnatomy);
        expect(one(dom, 'ai-folded-talk', 'label')!.textContent).toBe('Forge and Lint exchanged 4 messages ·');
        const show = buttonNamed(dom, 'show');
        expect(show.getAttribute('aria-expanded')).toBe('false');
        show.click();
        const open = mount(<FoldedTalk names={['Forge', 'Lint']} count={4} open onToggle={(o) => asked.push(o)} />);
        buttonNamed(open, 'hide').click();
        expect(asked).toEqual([true, false]);
    });
});

describe('Lane', () => {
    it('working: steps and messages in order, a message to another agent labelled', () => {
        const dom = mount(
            <Lane
                agent={{ name: 'Forge', hue: 2 }}
                state="working"
                task="#21 · Real register build"
                startedAt={NOW - 252_000}
                now={NOW}
                entries={[
                    { kind: 'message', id: 'm1', text: 'Trying a leaner build:ds without the prod bundle and tsc.' },
                    { kind: 'step', step: FORGE_STEPS[0]! },
                    { kind: 'step', step: FORGE_STEPS[1]! },
                    { kind: 'message', id: 'm2', text: 'Fragment check needs @agentic/core built.', to: 'Atlas' },
                    { kind: 'step', step: FORGE_STEPS[4]! }
                ]}
            />
        );
        expectAnatomy(dom, aiLaneAnatomy);
        expect(one(dom, 'ai-lane', 'root')!.getAttribute('data-state')).toBe('running');
        expect(one(dom, 'ai-lane', 'elapsed')!.textContent).toBe('4m 12s');
        expect(one(dom, 'ai-lane', 'task')!.textContent).toBe('#21 · Real register build');
        const body = one(dom, 'ai-lane', 'body')!;
        const order = [...body.children].map((c) => `${c.getAttribute('data-part')}:${c.children.length}`);
        expect(order).toEqual(['message:0', 'list:2', 'message:1', 'list:1']);
        const messages = all(dom, 'ai-lane', 'message');
        expect(one(messages[0]!, 'ai-lane', 'to')).toBeNull();
        expect(one(messages[1]!, 'ai-lane', 'to')!.textContent).toBe('to Atlas');
        expect(one(dom, 'ai-lane', 'footer')).toBeNull();
        expect(one(dom, 'ai-lane', 'question')).toBeNull();
    });

    it('done: the footer ticks the item', () => {
        const dom = mount(<Lane agent={{ name: 'Lint', hue: 3 }} state="done" task="#22 · Check fragments" startedAt={0} endedAt={100_000} done="Done · #22 ticked" />);
        expect(one(dom, 'ai-lane', 'root')!.getAttribute('data-state')).toBe('complete');
        expect(one(dom, 'ai-lane', 'elapsed')!.textContent).toBe('1m 40s');
        expect(one(dom, 'ai-lane', 'footer')!.textContent).toBe('Done · #22 ticked');
    });

    it('waiting on you: `waits 6m`, and the question with its answers on the footer', () => {
        const answered: string[] = [];
        const dom = mount(
            <Lane
                agent={{ name: 'Scout', hue: 4 }}
                state="needs-you"
                task="#23 · Drop vite from the static lane?"
                startedAt={NOW - 360_000}
                now={NOW}
                question={{ text: 'Asks you: keep vite or try the sigx bundler?', options: ['Keep vite', 'Try sigx'] }}
                onAnswer={(o) => answered.push(o)}
            />
        );
        expect(one(dom, 'ai-lane', 'root')!.getAttribute('data-state')).toBe('loading');
        expect(one(dom, 'ai-lane', 'elapsed')!.textContent).toBe('waits 6m 0s');
        const q = one(dom, 'ai-lane', 'question')!;
        expect(q.textContent).toContain('keep vite or try the sigx bundler?');
        expect(one(dom, 'ai-lane', 'footer')).toBeNull();
        buttonNamed(q, 'Try sigx').click();
        expect(answered).toEqual(['Try sigx']);
    });
});

describe('FollowPanel', () => {
    it('working: task, env with the count, the last steps, live output with a cursor, Message and Stop', () => {
        const calls: string[] = [];
        const dom = mount(
            <FollowPanel
                agent={{ name: 'Forge', hue: 2 }}
                state="working"
                task="Real register build · #21"
                env="alien01 / claude-code"
                steps={FORGE_STEPS}
                stepCount={23}
                output={['[sigx] [agentic] audit: 0 error(s), 0 warning(s), 6 info', '[sigx] [agentic] writing components.d.ts']}
                now={NOW}
                onMessage={() => calls.push('message')}
                onStop={() => calls.push('stop')}
                onClose={() => calls.push('close')}
            />
        );
        expectAnatomy(dom, aiFollowAnatomy);
        expect(one(dom, 'ai-follow', 'title')!.textContent).toBe('Following Forge');
        expect(one(dom, 'ai-follow', 'env')!.textContent).toBe('alien01 / claude-code · 23 steps');
        expect(all(dom, 'ai-follow', 'label').map((l) => l.textContent)).toEqual(['Last steps', 'Live output']);
        expect(all(dom, 'ai-steps', 'step')).toHaveLength(5);
        const out = one(dom, 'ai-follow', 'output')!;
        expect(out.tagName).toBe('PRE');
        expect(out.textContent).toContain('writing components.d.ts');
        expect(one(out, 'ai-follow', 'cursor')).not.toBeNull();
        buttonNamed(dom, 'Message Forge').click();
        const stop = buttonNamed(dom, 'Stop');
        expect(stop.getAttribute('data-intent')).toBe('danger');
        stop.click();
        buttonNamed(dom, 'Close').click();
        expect(calls).toEqual(['message', 'stop', 'close']);
    });

    it('keeps only the latest steps and output lines', () => {
        const steps = Array.from({ length: 9 }, (_, i) => step({ id: `x${i}`, target: `step ${i}` }));
        const output = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        const dom = mount(<FollowPanel agent={{ name: 'Forge' }} state="working" task="Build" steps={steps} output={output} />);
        expect(all(dom, 'ai-steps', 'target').map((t) => t.textContent)).toEqual(['step 3', 'step 4', 'step 5', 'step 6', 'step 7', 'step 8']);
        const text = one(dom, 'ai-follow', 'output')!.textContent!;
        expect(text).toContain('line 19');
        expect(text).toContain('line 12');
        expect(text).not.toContain('line 11');
    });

    it('waiting on you: Stop stays, no cursor', () => {
        const dom = mount(<FollowPanel agent={{ name: 'Scout' }} state="needs-you" task="Drop vite?" onStop={() => {}} />);
        expect(buttonNamed(dom, 'Stop')).toBeTruthy();
        expect(one(dom, 'ai-follow', 'cursor')).toBeNull();
    });

    it('done: the result, no cursor and no Stop', () => {
        const dom = mount(<FollowPanel agent={{ name: 'Lint' }} state="done" task="Check fragments · #22" output={['ok']} result="34 scopes, 0 errors." onStop={() => {}} onMessage={() => {}} />);
        expect(one(dom, 'ai-follow', 'result')!.textContent).toBe('34 scopes, 0 errors.');
        expect(one(dom, 'ai-follow', 'cursor')).toBeNull();
        expect(() => buttonNamed(dom, 'Stop')).toThrow();
        expect(buttonNamed(dom, 'Message Lint')).toBeTruthy();
    });
});

describe('the team recipes', () => {
    it('style every part of the six scopes, which the fragment declares and the root exports by scope name', () => {
        const byScope = new Map(recipes.map((r) => [r.component, r]));
        for (const a of teamAnatomies) {
            const parts = Object.keys(byScope.get(a.scope)?.parts ?? {});
            expect(parts, a.scope).toEqual(expect.arrayContaining(a.toJSON().parts.map((p) => p.name)));
        }
        expect(SCOPES).toEqual(expect.arrayContaining(['ai-crew', 'ai-handoff', 'ai-work-card', 'ai-folded-talk', 'ai-lane', 'ai-follow']));
        for (const name of ['AiCrew', 'AiHandoff', 'AiWorkCard', 'AiFoldedTalk', 'AiLane', 'AiFollow']) expect(root, name).toHaveProperty(name);
        expect(byScope.get('ai-follow')!.parts!.root!.base).toMatchObject({ inlineSize: '330px' });
        expect(byScope.get('ai-crew')!.parts!.root!.base).toMatchObject({ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' });
    });
});
