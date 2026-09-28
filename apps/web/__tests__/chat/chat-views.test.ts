/**
 * The chat-view seam's pure parts (#1058): the pick rule, the detail default, the header note, the scroll
 * anchor, the saved choices, Raw's read-back, the live lines and a step's `Full output` address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscript, type AgentEvent } from '@sigx/ai-agent';
import type { AgentMessage } from '@sigx/ai-agent/app';
import type { StepsMessage } from '@agentic/ui';
import type { TranscriptStep, TurnSteps } from '@agentic/core';
import { lookupOver } from '../../src/pages/chat/live';
import { EXPANDED_CAP, resetViewPrefs, setStepsExpanded, setViewDetail, setViewPin, viewPrefs } from '../../src/pages/chat/view-prefs';
import { LANES_MIN_WIDTH, agentsAtWork, anchorOf, defaultDetail, pickDetail, pickView, restoreScroll, viewNote } from '../../src/pages/chat/views/pick';
import { foldSession, turnToolParts, withRawTurns } from '../../src/pages/chat/views/raw';
import { currentStep, liveWorkOf } from '../../src/pages/chat/views/live-work';
import { stepHrefOf } from '../../src/pages/chat/views/step-href';
import { CHAT_VIEWS } from '../../src/pages/chat/views';

afterEach(() => {
    globalThis.localStorage?.clear();
    resetViewPrefs();
});

describe('pickView', () => {
    it('0 or 1 agents at work is Focus, 2 or more is Team', () => {
        expect(pickView(0).view).toBe('focus');
        expect(pickView(1).view).toBe('focus');
        expect(pickView(2).view).toBe('team');
        expect(pickView(5)).toEqual({ view: 'team', rule: 'auto', working: 5 });
    });

    it('a pin wins over the count', () => {
        expect(pickView(3, 'focus')).toEqual({ view: 'focus', rule: 'pinned', working: 3 });
        expect(pickView(0, 'team').view).toBe('team');
        expect(pickView(1, 'lanes', 1280).view).toBe('lanes');
    });

    it('Lanes becomes Team below 1024 px; a server render (no width) keeps it', () => {
        expect(pickView(2, 'lanes', LANES_MIN_WIDTH - 1)).toEqual({ view: 'team', rule: 'pinned', working: 2, narrowed: true });
        expect(pickView(2, 'lanes', LANES_MIN_WIDTH).view).toBe('lanes');
        expect(pickView(2, 'lanes').view).toBe('lanes');
    });

    it('counts an agent once however many ways it is at work', () => {
        expect(agentsAtWork(new Set(['forge', 'lint']), ['lint', 'scout'], ['forge']).size).toBe(3);
        expect(agentsAtWork().size).toBe(0);
    });
});

describe('the detail level', () => {
    it('follows the view: Team is Messages, Focus and Lanes are Steps', () => {
        expect(defaultDetail('team')).toBe('messages');
        expect(defaultDetail('focus')).toBe('steps');
        expect(defaultDetail('lanes')).toBe('steps');
    });

    it('a saved detail wins', () => {
        expect(pickDetail('team', 'raw')).toBe('raw');
        expect(pickDetail('focus', undefined)).toBe('steps');
    });
});

describe('viewNote', () => {
    it('names the rule that chose the view', () => {
        expect(viewNote(pickView(1))).toBe('one agent working · Focus picked automatically');
        expect(viewNote(pickView(0))).toBe('no agent working · Focus picked automatically');
        expect(viewNote(pickView(3))).toBe('3 agents working · Team picked automatically');
        expect(viewNote(pickView(1, 'lanes', 1280))).toBe('pinned by you · one column per agent at work');
        expect(viewNote(pickView(1, 'lanes', 400))).toBe('pinned by you · Lanes needs a wider screen, showing Team');
    });
});

describe('the scroll anchor', () => {
    it('is the first row whose bottom is below the top, with its offset', () => {
        expect(anchorOf([{ top: -300, bottom: -10 }, { top: -10, bottom: 120 }, { top: 120, bottom: 400 }])).toEqual({ index: 1, offset: -10 });
        expect(anchorOf([])).toBeNull();
    });

    it('scrolls the anchor row back to where it sat', () => {
        // The row now sits 500 px below the scroller's top; it sat 20 px below it.
        expect(restoreScroll(1000, { index: 3, offset: 20 }, 500)).toBe(1480);
        expect(restoreScroll(0, { index: 0, offset: 50 }, 0)).toBe(0);
    });
});

describe('view-prefs', () => {
    it('keeps the pin, the detail and the opened boxes per workspace and chat, in storage', () => {
        setViewPin('ws1', 'c1', 'lanes');
        setViewDetail('ws1', 'c1', 'raw');
        setStepsExpanded('ws1', 'c1', 'm1', true);
        setStepsExpanded('ws1', 'c1', 'm2', true);
        setStepsExpanded('ws1', 'c1', 'm1', false);
        expect(viewPrefs('ws1', 'c1')).toEqual({ pin: 'lanes', detail: 'raw', expanded: ['m2'] });
        expect(viewPrefs('ws1', 'c2')).toEqual({ expanded: [] });
        // A new page reads them back.
        resetViewPrefs();
        expect(viewPrefs('ws1', 'c1')).toEqual({ pin: 'lanes', detail: 'raw', expanded: ['m2'] });
        expect(viewPrefs('ws2', 'c1')).toEqual({ expanded: [] });
    });

    it('unpins', () => {
        setViewPin('ws1', 'c1', 'team');
        setViewPin('ws1', 'c1', undefined);
        expect(viewPrefs('ws1', 'c1').pin).toBeUndefined();
    });

    it('drops what storage holds that it does not know, and keeps only the newest opened boxes', () => {
        globalThis.localStorage.setItem('agentic:chat-view:ws1', JSON.stringify({ c1: { pin: 'grid', detail: 'all', expanded: ['m1', 3] }, c2: 'x' }));
        expect(viewPrefs('ws1', 'c1')).toEqual({ expanded: ['m1'] });
        expect(viewPrefs('ws1', 'c2')).toEqual({ expanded: [] });
        for (let i = 0; i < EXPANDED_CAP + 5; i++) setStepsExpanded('ws1', 'c3', `m${i}`, true);
        expect(viewPrefs('ws1', 'c3').expanded).toHaveLength(EXPANDED_CAP);
        expect(viewPrefs('ws1', 'c3').expanded[0]).toBe('m5');
    });

    it('lives for the page when storage refuses', () => {
        const store = globalThis.localStorage;
        const setItem = store.setItem;
        store.setItem = () => { throw new Error('quota'); };
        try {
            setViewDetail('ws1', 'c1', 'messages');
            expect(viewPrefs('ws1', 'c1').detail).toBe('messages');
        } finally {
            store.setItem = setItem;
        }
    });
});

describe('the registry', () => {
    it('holds Focus, and Team and Lanes', () => {
        expect(Object.keys(CHAT_VIEWS).sort()).toEqual(['focus', 'lanes', 'team']);
    });
});

const ev = (seq: number, e: Record<string, unknown>): AgentEvent => ({ sessionId: 's1', epoch: 1, seq, ...e }) as unknown as AgentEvent;

/** One finished turn `tu1`: a Bash call then the final text. */
const turnEvents: AgentEvent[] = [
    ev(1, { type: 'turn-start', turnId: 'tu1', input: [{ type: 'text', text: 'go' }] }),
    ev(2, { type: 'tool-call', turnId: 'tu1', callId: 'c1', name: 'Bash', input: { command: 'pnpm test' }, status: 'completed', output: '42 passed' }),
    ev(3, { type: 'part-start', turnId: 'tu1', partId: 'p1', part: { type: 'text', text: '' } }),
    ev(4, { type: 'part-delta', turnId: 'tu1', partId: 'p1', delta: 'Done.' }),
    ev(5, { type: 'part-end', turnId: 'tu1', partId: 'p1' }),
    ev(6, { type: 'turn-end', turnId: 'tu1', stopReason: 'end_turn' })
];

const steps = (turnId: string): TurnSteps => ({ turnId, steps: [], total: 1 });

describe('Raw on a finished turn', () => {
    it('reads the turn\'s calls out of its session log', () => {
        const t = foldSession('s1', turnEvents);
        expect(turnToolParts(t, 'tu1').map((p) => (p.type === 'tool' ? p.name : p.type))).toEqual(['Bash']);
        expect(turnToolParts(t, 'nope')).toEqual([]);
    });

    it('puts the calls in front of the text of the messages whose log was read', () => {
        const folded = { s1: foldSession('s1', turnEvents) };
        const m1: StepsMessage = { id: 'm1', role: 'assistant', actor: 'forge', parts: [{ type: 'text', id: 'm1:0', text: 'Done.' }], steps: steps('tu1') };
        const m2: StepsMessage = { id: 'm2', role: 'assistant', actor: 'forge', parts: [{ type: 'text', id: 'm2:0', text: 'Other.' }], steps: steps('tu2') };
        const user: AgentMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] };
        const out = withRawTurns([user, m1, m2], (m) => (m.id === 'u1' ? undefined : 's1'), folded);
        expect(out[0]).toBe(user);
        expect(out[1]!.parts.map((p) => p.type)).toEqual(['tool', 'text']);
        // Its turn is not in the log: kept as it is.
        expect(out[2]).toBe(m2);
        // Not read yet: kept as it is.
        expect(withRawTurns([m1], () => 's1', {})[0]).toBe(m1);
    });
});

describe('live lines', () => {
    const lookup = lookupOver({ forge: { id: 'forge', name: 'Forge', role: '', description: '', hue: 2, environment: { machine: 'm', runtime: 'claude-code', account: 'a' }, configVersion: 1 } });

    it('one per feed mid-turn: its newest running step, its start, its Stop', () => {
        const running = createTranscript('s1');
        running.state = 'running';
        running.turn = { turnId: 'tu9' };
        running.messages.push({ id: 'x1', role: 'assistant', turnId: 'tu9', parts: [
            { type: 'tool', callId: 'k1', name: 'Read', status: 'completed', input: { file_path: 'a.ts' } },
            { type: 'tool', callId: 'k2', name: 'Edit', status: 'in_progress', input: { file_path: 'packages/ui/package.json' } }
        ] });
        const idle = createTranscript('s2');
        const stopped: string[] = [];
        const lines = liveWorkOf([{ sessionId: 's1', agentId: 'forge', transcript: running, turnStartedAt: 1000 }, { sessionId: 's2', agentId: 'forge', transcript: idle }], lookup, 5000, (f) => stopped.push(f.sessionId));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ agentId: 'forge', name: 'Forge', hue: 2, startedAt: 1000, step: 'Edit · packages/ui/package.json' });
        lines[0]!.onStop!();
        expect(stopped).toEqual(['s1']);
    });

    it('no step before the first call; `now` when the start was not seen', () => {
        const t = createTranscript('s1');
        t.state = 'running';
        t.turn = { turnId: 'tu1' };
        expect(currentStep(t)).toBeUndefined();
        expect(liveWorkOf([{ sessionId: 's1', agentId: 'forge', transcript: t }], lookup, 7000)[0]).toEqual({ agentId: 'forge', name: 'Forge', hue: 2, startedAt: 7000 });
    });
});

describe('a step\'s Full output', () => {
    const step = (extra: Partial<TranscriptStep>): TranscriptStep => ({ id: 'c7', turnId: 't', agentId: 'forge' as TranscriptStep['agentId'], kind: 'command', tool: 'Bash', target: 'x', state: 'error', ...extra });

    it('goes to its own ref, else to its call in the agent\'s session', () => {
        const href = stepHrefOf((agentId) => (agentId === 'forge' ? 's9' : undefined));
        expect(href(step({ output: { lines: 1, excerpt: ['e'], picked: 'error', ref: 's1#c7' } }))).toBe('/sessions/s1?call=c7');
        expect(href(step({}))).toBe('/sessions/s9?call=c7');
        expect(href(step({ agentId: 'lint' as TranscriptStep['agentId'] }))).toBeUndefined();
    });
});
