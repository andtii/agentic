import type { AgentId, Author, ChatEntry, MessageId, StepKind, StepState, TranscriptStep, TurnSteps } from '../src/index';
import { audienceOf, formatExcerptNote, formatStepSummary, pickExcerpt, stepKindOf, summariseSteps, turnOpensItself } from '../src/index';

const forge = 'forge' as AgentId;
const lint = 'lint' as AgentId;
const atlas = 'atlas' as AgentId;

let n = 0;
function step(kind: StepKind, tool: string, target: string, state: StepState = 'done', extra: Partial<TranscriptStep> = {}): TranscriptStep {
    return { id: `s${++n}`, turnId: 't1', agentId: forge, kind, tool, target, state, ...extra };
}
const turn = (steps: TranscriptStep[], extra: Partial<TurnSteps> = {}): TurnSteps => ({ turnId: 't1', steps, total: steps.length, ...extra });

describe('stepKindOf (#1053)', () => {
    it('maps the coding categories', () => {
        expect(stepKindOf('execute')).toBe('command');
        expect(stepKindOf('read')).toBe('read');
        expect(stepKindOf('edit')).toBe('edit');
        expect(stepKindOf('delete')).toBe('edit');
        expect(stepKindOf('move')).toBe('edit');
        expect(stepKindOf('search')).toBe('search');
        expect(stepKindOf('fetch')).toBe('search');
        expect(stepKindOf('think')).toBe('other');
        expect(stepKindOf()).toBe('other');
        expect(stepKindOf(undefined, 'Bash')).toBe('other');
    });
    it('maps the delegation tools to delegate, whatever the category', () => {
        expect(stepKindOf(undefined, 'delegate')).toBe('delegate');
        expect(stepKindOf('other', 'plan_assign')).toBe('delegate');
        expect(stepKindOf('execute', 'mcp__agentic__plan_handoff')).toBe('delegate');
        expect(stepKindOf(undefined, 'mcp__agentic__tasks_delegate')).toBe('delegate');
    });
});

describe('summariseSteps + formatStepSummary (#1053)', () => {
    it('5 steps · 3 commands, 2 reads · 1 failed, recovered', () => {
        const s = turn([
            step('read', 'Read', 'package.json'),
            step('command', 'Bash', 'pnpm build', 'error', { exitCode: 1 }),
            step('read', 'Read', 'vite.config.ts'),
            step('command', 'Bash', 'pnpm install'),
            step('command', 'Bash', 'pnpm build'),
        ]);
        const summary = summariseSteps(s);
        expect(summary).toEqual({ total: 5, byKind: { read: 2, command: 3 }, failed: 1, recovered: 1 });
        expect(formatStepSummary(summary)).toBe('5 steps · 3 commands, 2 reads · 1 failed, recovered');
        expect(turnOpensItself(s)).toBe(false);
    });
    it('3 steps · 3 commands · 1 failed', () => {
        const s = turn([step('command', 'Bash', 'pnpm install'), step('command', 'Bash', 'pnpm lint'), step('command', 'Bash', 'pnpm test', 'error', { exitCode: 1 })]);
        expect(formatStepSummary(summariseSteps(s))).toBe('3 steps · 3 commands · 1 failed');
        expect(turnOpensItself(s)).toBe(true);
    });
    it('names partial recovery, singulars and uses total past a cap', () => {
        const s = turn(
            [step('edit', 'Edit', 'a.ts', 'error'), step('edit', 'Edit', 'a.ts'), step('command', 'Bash', 'x', 'error'), step('command', 'Bash', 'y')],
            { total: 40 },
        );
        expect(formatStepSummary(summariseSteps(s))).toBe('40 steps · 2 commands, 2 edits · 2 failed, 1 recovered');
        expect(formatStepSummary(summariseSteps(turn([step('search', 'Grep', 'foo')])))).toBe('1 step · 1 search');
    });
    it('duration from the turn, else from the steps', () => {
        expect(summariseSteps(turn([], { startedAt: 1000, endedAt: 4000 })).durationMs).toBe(3000);
        const s = turn([step('read', 'Read', 'a', 'done', { startedAt: 100, endedAt: 200 }), step('read', 'Read', 'b', 'done', { startedAt: 250, endedAt: 900 })]);
        expect(summariseSteps(s).durationMs).toBe(800);
        expect('durationMs' in summariseSteps(turn([step('read', 'Read', 'a')]))).toBe(false);
    });
});

describe('turnOpensItself (#1053)', () => {
    it('a failure retried and still failing opens the turn', () => {
        expect(turnOpensItself(turn([step('command', 'Bash', 'pnpm test', 'error'), step('command', 'Bash', 'pnpm test', 'error')]))).toBe(true);
    });
    it('a success BEFORE the failure does not recover it', () => {
        expect(turnOpensItself(turn([step('command', 'Bash', 'pnpm test'), step('command', 'Bash', 'pnpm test', 'error')]))).toBe(true);
    });
    it('no failure stays shut', () => {
        expect(turnOpensItself(turn([step('read', 'Read', 'a'), step('command', 'Bash', 'b', 'denied')]))).toBe(false);
    });
});

describe('pickExcerpt (#1053)', () => {
    const fourteen = [
        '> agentic@0.0.0 build',
        '> vite build',
        'vite v7 building for production...',
        'transforming...',
        '✓ 103 modules transformed.',
        'rendering chunks...',
        'src/app.ts (12:4)',
        'Error: Could not resolve "./missing"',
        'computing gzip size...',
        'dist/index.js  12 kB',
        'dist/app.js  30 kB',
        'done in 2.1s',
        'ELIFECYCLE',
        'exit',
    ].join('\n');
    it('exit 1 · 2 of 14 lines, picked by error', () => {
        const out = pickExcerpt(fourteen, 1);
        expect(out).toEqual({ lines: 14, excerpt: ['src/app.ts (12:4)', 'Error: Could not resolve "./missing"'], picked: 'error' });
        expect(formatExcerptNote(out, 1)).toBe('exit 1 · 2 of 14 lines, picked by error');
    });
    it('the last 3 lines when nothing matches, also on a non-zero exit', () => {
        const out = pickExcerpt('a\nb\nc\nd\ne\n', 2);
        expect(out).toEqual({ lines: 5, excerpt: ['c', 'd', 'e'], picked: 'tail' });
        expect(formatExcerptNote(out, 2)).toBe('exit 2 · 3 of 5 lines, picked by tail');
        expect(pickExcerpt('')).toEqual({ lines: 0, excerpt: [], picked: 'tail' });
    });
    it('at most 8 lines, context not duplicated, CRLF handled', () => {
        const text = Array.from({ length: 20 }, (_, i) => (i % 2 ? `failed ${i}` : `ctx ${i}`)).join('\r\n');
        const out = pickExcerpt(text, 1);
        expect(out.excerpt).toEqual(['ctx 0', 'failed 1', 'ctx 2', 'failed 3', 'ctx 4', 'failed 5', 'ctx 6', 'failed 7']);
        expect(out.lines).toBe(20);
        expect(pickExcerpt('Cannot find module\nnext').excerpt).toEqual(['Cannot find module']);
    });
});

describe('audienceOf (#1053)', () => {
    const msg = (author: Author, mentions: AgentId[]): ChatEntry => ({
        t: 'msg',
        id: 'm1' as MessageId,
        author,
        parts: [{ type: 'text', text: 'hi' }],
        at: 1,
        mentions,
    });
    const members = [forge, lint, atlas];
    it('a user message goes to people', () => {
        expect(audienceOf(msg({ kind: 'user' }, [forge]), members)).toBe('people');
    });
    it('an agent message mentioning another member goes to that agent', () => {
        expect(audienceOf(msg({ kind: 'agent', agentId: forge }, [forge, lint]), members)).toBe(lint);
    });
    it('an agent message to nobody, itself or a non-member goes to people', () => {
        expect(audienceOf(msg({ kind: 'agent', agentId: forge }, []), members)).toBe('people');
        expect(audienceOf(msg({ kind: 'agent', agentId: forge }, [forge, 'stranger' as AgentId]), members)).toBe('people');
    });
    it('anything else goes to people', () => {
        expect(audienceOf({ t: 'coordinator', agentId: forge, at: 1 }, members)).toBe('people');
    });
});
