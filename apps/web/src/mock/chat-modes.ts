/**
 * The chat-modes sample chats (#1058; `docs/design/chat-modes/`): the build:ds chat from `ChatFocus.png` —
 * one agent, finished turns with their steps, a failure that stopped the work, the live line — and the
 * four-agent "Real register for sigx zero" chat from `ChatTeam.png` / `ChatLanes.png` — handoff steps from
 * the coordinator, a finished turn, a question for you and a live feed for Forge.
 *
 * Loadable by id (`chatSummary`, `loadChat` in `workspace.ts`), not listed: the chat lists keep their own
 * samples. Nothing here reads `workspace.ts` at module load (the two import each other).
 */
import type { StepKind, TranscriptStep, TurnSteps } from '@agentic/core';
import { createTranscript } from '@sigx/ai-agent';
import type { OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import type { MessageAuthor, StepsMessage } from '@agentic/ui';
import { USER, agentNamed, formatTime, type MockChatSummary, type MockChatView } from './workspace';

/** The workspace clock (`MOCK_NOW` in `workspace.ts`), kept here so this module needs nothing of it at load. */
const NOW = Date.parse('2026-09-17T12:16:00Z');
const ago = (minutes: number): number => NOW - minutes * 60_000;

/** An agent at work in a sample chat: its live line (Focus) — what it does now and for how long. */
export interface MockLiveWork {
    readonly agentId: string;
    readonly step: string;
    /** Seconds it has worked, as of the page's load. */
    readonly seconds: number;
}

export const MODE_CHATS: readonly MockChatSummary[] = [
    {
        id: 'cm1',
        title: 'Leaner build:ds for the static lane',
        members: [{ agentId: 'forge', status: 'active', history: { access: 'all' } }],
        lastLine: 'zero:build alone works: 103 artifacts in 0.7 s',
        unread: 0,
        waiting: false,
        updatedAt: ago(1),
        projectId: 'p_agentic'
    },
    {
        id: 'cm2',
        title: 'Real register for sigx zero',
        members: [
            { agentId: 'atlas', status: 'idle', coordinator: true, history: { access: 'all' } },
            { agentId: 'forge', status: 'active', history: { access: 'all' } },
            { agentId: 'lint', status: 'idle', history: { access: 'all' } },
            { agentId: 'scout', status: 'waiting', history: { access: 'all' } }
        ],
        lastLine: 'Scout asked a question',
        unread: 0,
        waiting: true,
        updatedAt: ago(2),
        projectId: 'p_agentic'
    }
];

type StepInput = Omit<TranscriptStep, 'turnId' | 'agentId' | 'startedAt' | 'endedAt'> & { readonly ms: number };

/** A turn's steps, back to back from `startedAt`, as the Session summarises a finished turn (#1055). */
function turn(turnId: string, agentId: string, startedAt: number, steps: readonly StepInput[]): TurnSteps {
    let at = startedAt;
    const out = steps.map(({ ms, ...s }): TranscriptStep => {
        const step = { ...s, turnId, agentId: agentId as TranscriptStep['agentId'], startedAt: at, endedAt: at + ms };
        at += ms + 200;
        return step;
    });
    return { turnId, steps: out, total: out.length, startedAt, endedAt: at };
}

const step = (id: string, kind: StepKind, tool: string, target: string, ms: number, extra: Partial<StepInput> = {}): StepInput => ({ id, kind, tool, target, state: 'done', ms, ...extra });

/** Raw detail on the sample turns: each step as the tool call it was — its input and its output. */
export function rawCallsOf(steps: TurnSteps): ToolPartState[] {
    return steps.steps.map((s): ToolPartState => ({
        type: 'tool',
        callId: s.id,
        name: s.tool,
        status: s.state === 'error' ? 'failed' : s.state === 'running' ? 'in_progress' : 'completed',
        input: s.kind === 'command' ? { command: s.target } : s.kind === 'delegate' ? { objective: s.target } : { file_path: s.target },
        ...(s.state === 'error' ? { error: s.output?.excerpt.join('\n') ?? 'failed' } : { output: s.result ?? 'ok' })
    }));
}

const at = (ms: number): MessageAuthor['time'] => ({ text: formatTime(ms), dateTime: new Date(ms).toISOString() });
const agentAuthor = (agentId: string, ms: number, thoughtSeconds?: number): MessageAuthor => {
    const a = agentNamed(agentId);
    return { name: a.name, hue: a.hue, environment: a.environment, time: at(ms), ...(thoughtSeconds !== undefined ? { thoughtSeconds } : {}) };
};
const text = (id: string, value: string) => ({ type: 'text' as const, id, text: value });

export type ModeChatView = Omit<MockChatView, 'chat' | 'tasks'>;

function buildDsChat(): ModeChatView {
    const transcript = createTranscript('s_chat_cm1');
    const first = turn('tu_bd1', 'forge', ago(3), [
        step('c_bd1', 'read', 'Read', 'package.json', 100),
        step('c_bd2', 'read', 'Read', 'packages/ui/vite.config.ts', 100),
        step('c_bd3', 'command', 'Bash', 'pnpm --filter @agentic/ui build:ds', 6200, { state: 'error', exitCode: 1, output: { lines: 9, excerpt: ['[vite] error during build:', 'Cannot find module \'@agentic/core\''], picked: 'error', ref: 's1#c_bd3' } }),
        step('c_bd4', 'command', 'Bash', 'pnpm --filter @agentic/ui build:ds', 9100, { result: 'built' }),
        step('c_bd5', 'command', 'Bash', 'pnpm size', 1800, { result: 'within budget' })
    ]);
    const second = turn('tu_bd2', 'forge', ago(2), [
        step('c_bd6', 'read', 'Read', 'packages/ui/package.json', 100),
        step('c_bd7', 'command', 'Bash', "grep -rn '@agentic/ui/register' apps/web/src", 300, { result: '3 matches' }),
        step('c_bd8', 'command', 'Bash', 'npx vite build && npx sigx zero:fragment --strict', 2400, {
            state: 'error',
            exitCode: 1,
            output: { lines: 14, excerpt: ['[sigx] ERROR: the package root could not be read: packages/ui/dist/index.js failed to load', "Cannot find module '@agentic/core/dist/index.js' imported from packages/ui/dist/index.js"], picked: 'error', ref: 's1#c_bd8' }
        }),
        step('c_bd9', 'command', 'Bash', 'npx sigx zero:build ./dist/design-system.js --extra-manifest ./dist/fragment.json', 700, { result: 'built 103 artifacts' })
    ]);
    const m2: StepsMessage = { id: 'm2', role: 'assistant', actor: 'forge', parts: [{ type: 'reasoning', id: 'p2r', text: 'The static lane only needs the design system and the fragment check.', done: true }, text('p2', 'Trying a leaner `build:ds`: the vite build plus the two `sigx zero` steps, without the prod bundle and `tsc`.')], steps: first };
    const m3: StepsMessage = { id: 'm3', role: 'assistant', actor: 'forge', parts: [{ type: 'reasoning', id: 'p3r', text: 'The strict fragment check imports the package root.', done: true }, text('p3', 'The fragment check loads the whole package, which needs `@agentic/core` built. `zero:build` alone works: 103 artifacts in 0.7 s, no errors.')], steps: second };
    transcript.messages.push({ id: 'm1', role: 'user', author: USER.name, parts: [{ type: 'text', text: 'build:ds adds 40 s to the static lane. Make it leaner.' }] }, m2, m3);
    return {
        transcript,
        authors: { m1: { name: USER.name, person: true, time: at(ago(4)) }, m2: agentAuthor('forge', ago(3), 6), m3: agentAuthor('forge', ago(2), 4) },
        toolMeta: {},
        approvals: {},
        live: [{ agentId: 'forge', step: 'Edit · packages/ui/package.json · build:ds', seconds: 6 }],
        raw: { m2: rawCallsOf(first), m3: rawCallsOf(second) }
    };
}

function registerChat(): ModeChatView {
    const transcript = createTranscript('s_chat_cm2');
    const handoffs = turn('tu_rg1', 'atlas', ago(9), [
        step('c_rg1', 'delegate', 'delegate', 'Forge · Build the register in packages/ui', 300, { delegate: { to: 'forge' as TranscriptStep['agentId'], item: '#21' } }),
        step('c_rg2', 'delegate', 'delegate', 'Lint · Check the register against the anatomy', 300, { delegate: { to: 'lint' as TranscriptStep['agentId'], item: '#22' } }),
        step('c_rg3', 'delegate', 'delegate', 'Scout · Read how other kits name their registers', 300, { delegate: { to: 'scout' as TranscriptStep['agentId'], item: '#23' } })
    ]);
    const check = turn('tu_rg2', 'lint', ago(5), [
        step('c_rg4', 'read', 'Read', 'packages/ui/src/fragment/scopes.ts', 100),
        step('c_rg5', 'read', 'Read', 'packages/ui/src/fragment/recipes.ts', 100),
        step('c_rg6', 'command', 'Bash', 'pnpm --filter @agentic/ui test anatomy', 4100, { result: '41 of 43' })
    ]);
    const research = turn('tu_rg3', 'scout', ago(3), [
        step('c_rg7', 'search', 'WebSearch', 'design token register naming', 2300, { result: '8 results' })
    ]);
    const m2: StepsMessage = { id: 'm2', role: 'assistant', actor: 'atlas', parts: [text('p2', 'Splitting it three ways: Forge builds the register, Lint checks it against the anatomy, Scout reads how other kits do it.')], steps: handoffs };
    const m3: StepsMessage = { id: 'm3', role: 'assistant', actor: 'lint', parts: [text('p3', 'The anatomy check passes for 41 of 43 parts. Two scopes have no `data-part` on their root; I listed them on #22.')], steps: check };
    const m4: StepsMessage = { id: 'm4', role: 'assistant', actor: 'scout', parts: [text('p4', 'Before I go on: should the register follow zero\'s naming or ours?')], steps: research };
    const question: OpenRequest = { requestId: 'r_cm2', kind: 'input', toolName: 'ask_user', message: "Should the register follow zero's naming (`zero-*`) or ours (`ag-*`)?", seq: 40 };
    transcript.messages.push({ id: 'm1', role: 'user', author: USER.name, parts: [{ type: 'text', text: '@Atlas we need a real register for sigx zero: the fragment, the tokens and a size budget. Split it.' }] }, m2, m3, m4);
    transcript.requests[question.requestId] = question;
    transcript.state = 'awaiting';
    return {
        transcript,
        authors: { m1: { name: USER.name, person: true, time: at(ago(10)) }, m2: agentAuthor('atlas', ago(9)), m3: agentAuthor('lint', ago(5), 3), m4: agentAuthor('scout', ago(3)) },
        toolMeta: {},
        approvals: {},
        live: [{ agentId: 'forge', step: 'Bash · pnpm --filter @agentic/ui build', seconds: 132 }],
        raw: { m2: rawCallsOf(handoffs), m3: rawCallsOf(check), m4: rawCallsOf(research) }
    };
}

/** A sample chat's thread by id; `undefined` for any other chat. */
export function modeChatView(id: string): ModeChatView | undefined {
    if (id === 'cm1') return buildDsChat();
    if (id === 'cm2') return registerChat();
    return undefined;
}

