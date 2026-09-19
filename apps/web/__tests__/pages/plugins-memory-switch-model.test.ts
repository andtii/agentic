/** The words "Make active" puts on a memory plugin's dry run (#243): nothing to move, some left out, and the per-scope lines. */
import { describe, expect, it } from 'vitest';
import type { MemorySwitchReport } from '@agentic/platform';
import { memorySwitchText } from '../../src/pages/plugins/model';

const names: Record<string, string> = { 'agentic.memory.default': 'Memory', 'agentic.memory.flat': 'Flat memory' };
const nameOf = (id: string) => names[id] ?? id;
const agentName = (id: string) => (id === 'agent_1' ? 'Ada' : id);

const report = (over: Partial<MemorySwitchReport>): MemorySwitchReport => ({
    from: 'agentic.memory.flat',
    to: 'agentic.memory.default',
    dryRun: true,
    targetExport: 'full',
    entries: 0,
    imported: 0,
    skipped: 0,
    droppedFields: [],
    scopes: [],
    ...over
});
const scope = (s: `agent:${string}` | `shared:${string}`, entries: number) => ({ scope: s as never, report: { dryRun: true, entries, imported: entries, skipped: 0, droppedFields: [], kinds: {} } });

describe('memorySwitchText', () => {
    it('with nothing to move says so and just makes it active', () => {
        expect(memorySwitchText(report({}), nameOf, agentName)).toEqual({
            title: 'Make Memory active?',
            description: 'Flat memory holds no memories yet, so nothing moves. New sessions remember in Memory.',
            scopes: [],
            confirmLabel: 'Make active'
        });
    });

    it('names what is left out and says nothing is lost when the target keeps every field', () => {
        const text = memorySwitchText(report({ entries: 3, imported: 2, skipped: 1, scopes: [scope('agent:agent_1', 2), scope('shared:team', 1)] }), nameOf, agentName);
        expect(text.description).toBe('2 memories of 3 move from Flat memory to Memory. 1 is already there or cannot be held, so it stays out. Nothing is lost. Flat memory keeps its own copy, so switching back finds it again.');
        expect(text.scopes).toEqual(['Ada · 2 memories', 'Shared: team · 1 memory']);
        expect(text.confirmLabel).toBe('Move 2 memories and make active');
    });

    it('when everything is already there, says so instead of "Move 0 memories"', () => {
        const text = memorySwitchText(report({ entries: 3, imported: 0, skipped: 3, scopes: [scope('agent:agent_1', 3)] }), nameOf, agentName);
        expect(text.description).toBe('Nothing new to move: all 3 memories in Flat memory are already in Memory or cannot be held there. Nothing is lost. Flat memory keeps its own copy, so switching back finds it again.');
        expect(text.confirmLabel).toBe('Make active');
    });
});
