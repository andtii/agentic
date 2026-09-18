/**
 * The live agent pages' pure model (#153): presence and sessions from task
 * index rows, the rail's proposed version, the Ledger's week and months, the
 * learning patch, the pickers' catalogue — and the two mirrors the browser
 * keeps instead of importing a package (`PLATFORM_TOOLS`, `isoWeekOf`), pinned
 * against their sources.
 */
import type { AgentConfig, AgentId, SessionId, TaskId } from '@agentic/core';
import { isoWeek } from '@agentic/learning';
import { ledgerMonth, type AgentView, type ConnectorRecord, type PendingProposal, type TaskIndexRow } from '@agentic/platform';
import { PLATFORM_TOOL_NAMES } from '@agentic/runtimes';
import { setDataMode } from '../../src/data-mode';
import { PLATFORM_TOOLS, agentCatalog } from '../../src/pages/agent/catalog';
import { MOCK_NOW, age, dateTime, shortDate } from '../../src/pages/agent/format';
import { activeTasks, isoWeekOf, learningPatch, presenceOf, profileOf, proposedVersion, sessionRowsOf, tasksByAssignee, weekMonths } from '../../src/pages/agent/live';

const A = 'agent_a' as AgentId;
const B = 'agent_b' as AgentId;
const T0 = Date.UTC(2026, 8, 18, 9, 0);

let n = 0;
function row(extra: Partial<TaskIndexRow> = {}): TaskIndexRow {
    n += 1;
    return { id: `task_${n}` as TaskId, objective: `objective ${n}`, assignee: A, owner: A, status: 'active', origin: 'user', depth: 0, createdAt: T0 + n, updatedAt: T0 + n, n: 1, ...extra };
}

const config: AgentConfig = {
    name: 'Atlas',
    description: 'Coordinates.',
    role: 'Coordinator',
    instructions: 'Be brief.',
    skills: [{ id: 'git-worktree' }],
    tools: [{ name: 'memory_search' }, { name: 'custom_tool', mode: 'ask' }],
    connectors: [{ id: 'gone' }],
    approvalPolicy: [],
    memoryPolicy: { shared: ['team'], autoLearn: 'lessons' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};
const view: AgentView = { id: A, workspaceId: 'u1' as never, configVersion: 4, config, memoryScope: `agent:${A}`, pendingProposals: 0 };

afterEach(() => {
    setDataMode('mock');
    vi.useRealTimers();
});

describe('presence (from the task index)', () => {
    it('idle with nothing in flight, active with work, waiting when a person is asked', () => {
        expect(presenceOf([])).toBe('idle');
        expect(presenceOf([row({ status: 'completed' }), row({ status: 'failed' }), row({ status: 'cancelled' })])).toBe('idle');
        expect(presenceOf([row({ status: 'queued' })])).toBe('active');
        expect(presenceOf([row({ status: 'active' })])).toBe('active');
        // parked on a child or a queue is still the agent's work in flight
        expect(presenceOf([row({ status: 'waiting', wait: { kind: 'child', childTaskIds: [] } })])).toBe('active');
        expect(presenceOf([row({ status: 'active' }), row({ status: 'waiting', wait: { kind: 'approval', requestId: 'r1', sessionId: 's1' as SessionId } })])).toBe('waiting');
        expect(presenceOf([row({ status: 'waiting', wait: { kind: 'input', requestId: 'r2' } })])).toBe('waiting');
        // a settled task's stale wait reason says nothing
        expect(presenceOf([row({ status: 'completed', wait: { kind: 'input', requestId: 'r3' } })])).toBe('idle');
    });

    it('activeTasks and tasksByAssignee split the workspace index', () => {
        const rows = [row(), row({ assignee: B }), row({ status: 'completed' })];
        expect(activeTasks(rows)).toHaveLength(2);
        const by = tasksByAssignee(rows);
        expect(Object.keys(by).sort()).toEqual([A, B].sort());
        expect(by[A]).toHaveLength(2);
        expect(presenceOf(by[B]!)).toBe('active');
        expect(presenceOf(by['nobody'] ?? [])).toBe('idle');
    });
});

describe('sessions (from the task index)', () => {
    const environment = { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' };

    it('one row per session, newest first, tasks without a session left out', () => {
        const rows = [
            row({ sessionId: 's_old' as SessionId, status: 'completed', createdAt: T0 }),
            row({ status: 'queued', createdAt: T0 + 5_000 }),
            row({ sessionId: 's_new' as SessionId, status: 'active', createdAt: T0 + 10_000 }),
            // a second task on a session already listed (its newer row wins)
            row({ sessionId: 's_new' as SessionId, status: 'completed', createdAt: T0 + 1_000 })
        ];
        expect(sessionRowsOf(rows, environment)).toEqual([
            { id: 's_new', agentId: A, environment, status: 'active', startedAt: new Date(T0 + 10_000).toISOString(), turns: 0 },
            { id: 's_old', agentId: A, environment, status: 'completed', startedAt: new Date(T0).toISOString(), turns: 0 }
        ]);
        expect(sessionRowsOf([], environment)).toEqual([]);
    });
});

describe('profileOf with activity', () => {
    it('reads idle / empty / zero without activity, and folds what the actors report', () => {
        const bare = profileOf(view, [{ version: 4, at: 4, by: 'u', reason: 'r' }], 0);
        expect(bare).toMatchObject({ presence: 'idle', memories: [], activeOnOlder: 0, correctionsThisWeek: 0, repeatedMistakes: 0, learning: true });
        expect(bare.proposed).toBeUndefined();

        const proposal: PendingProposal = { id: 'prop_1', proposal: { kind: 'instruction', patch: ' Run the tests first. ', reason: 'Corrected twice.', requiresReview: true }, origin: { kind: 'correction', sessionId: 's1' as SessionId }, by: 'agent:a', at: 77, status: 'pending' };
        const full = profileOf(view, [], 0, { tasks: [row()], memories: [{ id: 'mem_1', kind: 'fact', text: 'x', tags: [], confidence: 'stated', provenance: { source: 'user', at: 1 } }], correctionsThisWeek: 3, repeatedMistakes: 1, activeOnOlder: 2, proposal });
        expect(full).toMatchObject({ presence: 'active', activeOnOlder: 2, correctionsThisWeek: 3, repeatedMistakes: 1 });
        expect(full.memories).toHaveLength(1);
        expect(full.proposed).toEqual({ version: 5, at: 77, by: 'learning', reason: 'Corrected twice. Adds: “Run the tests first.”' });
        expect(proposedVersion({ ...proposal, proposal: { ...proposal.proposal, reason: '  ' } }, 9).reason).toBe('Adds: “Run the tests first.”');
    });
});

describe('the Ledger week', () => {
    it('isoWeekOf is @agentic/learning’s isoWeek', () => {
        // Every day across three year boundaries, including the week-53 year 2026.
        for (let t = Date.UTC(2024, 11, 20); t < Date.UTC(2027, 0, 15); t += 86_400_000) expect(isoWeekOf(t)).toBe(isoWeek(t));
        expect(isoWeekOf(Date.UTC(2026, 8, 18))).toBe('2026-W38');
    });

    it('weekMonths names the ledgers a week has touched so far, in the platform’s month spelling', () => {
        // Friday 18 Sep 2026: the week started on Monday 14 Sep.
        expect(weekMonths(Date.UTC(2026, 8, 18))).toEqual(['2026-09']);
        // Thursday 1 Oct 2026: the week started on Monday 28 Sep.
        expect(weekMonths(Date.UTC(2026, 9, 1, 12))).toEqual(['2026-09', '2026-10']);
        // Wednesday 30 Sep: October has not started.
        expect(weekMonths(Date.UTC(2026, 8, 30, 23, 59))).toEqual(['2026-09']);
        // Sunday 3 Jan 2027 belongs to the week of Monday 28 Dec 2026.
        expect(weekMonths(Date.UTC(2027, 0, 3))).toEqual(['2026-12', '2027-01']);
        for (const t of [Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 3), Date.UTC(2026, 1, 28)]) expect(weekMonths(t).at(-1)).toBe(ledgerMonth(t));
    });
});

describe('learningPatch', () => {
    it('turns learning off and back on, keeping the shared scopes', () => {
        expect(learningPatch(config, false)).toEqual({ memoryPolicy: { shared: ['team'], autoLearn: 'off' } });
        expect(learningPatch(config, true)).toEqual({ memoryPolicy: { shared: ['team'], autoLearn: 'lessons' } });
        expect(learningPatch({ ...config, memoryPolicy: { shared: [], autoLearn: 'off' } }, true)).toEqual({ memoryPolicy: { shared: [], autoLearn: 'lessons' } });
    });
});

describe('the catalogue', () => {
    it('PLATFORM_TOOLS is the platform’s roster', () => {
        expect([...PLATFORM_TOOLS]).toEqual([...PLATFORM_TOOL_NAMES]);
    });

    it('offers only names that exist, plus what the agent already carries', () => {
        const github: ConnectorRecord = { id: 'github', pluginId: 'agentic.mcp', transport: 'http', url: 'https://example.test/mcp', tools: ['create_issue', 'memory_search'], status: 'ok' } as unknown as ConnectorRecord;
        const c = agentCatalog(config, [github]);
        expect(c.tools!.map((o) => o.value)).toEqual([...PLATFORM_TOOL_NAMES, 'create_issue', 'custom_tool']);
        // the design track's stale names are not offered
        expect(c.tools!.map((o) => o.value)).not.toContain('memory.search');
        expect(c.connectors).toEqual([{ value: 'github', label: 'github (http)' }, { value: 'gone' }]);
        expect(c.skills).toEqual([{ value: 'git-worktree' }]);
        expect(c.memoryScopes).toEqual([{ value: 'team' }]);
        // the environment picker is the machines wiring's (#144)
        expect(c.environments).toBeUndefined();
        expect(agentCatalog({ ...config, tools: [], connectors: [], skills: [] }, []).connectors).toEqual([]);
    });
});

describe('agent page times', () => {
    it('ages against the mock clock in mock mode and the real clock on the platform', () => {
        expect(age(MOCK_NOW - 14 * 60_000)).toBe('14m');
        vi.useFakeTimers({ now: T0 });
        setDataMode('live');
        expect(age(T0 - 3 * 3_600_000)).toBe('3h');
        expect(age(T0 - 14 * 60_000)).toBe('14m');
    });

    it('prints dates in the zone it is given, Stockholm by default', () => {
        const at = Date.UTC(2026, 8, 16, 23, 30);
        expect(dateTime(at)).toBe('17 Sep 01:30');
        expect(dateTime(at, 'UTC')).toBe('16 Sep 23:30');
        expect(shortDate(at, 'UTC')).toBe('16 Sep');
        expect(age(at, at + 30 * 3_600_000, 'UTC')).toBe('16 Sep');
        expect(dateTime(at, 'Not/AZone')).toBe('16 Sep 23:30');
    });
});
