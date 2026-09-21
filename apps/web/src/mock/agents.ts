/**
 * Agent-page mock data (issue #89): one profile per agent in `./data` with
 * the config, versions, memories and counters the roster, config, memory
 * and sessions views read. Shapes follow `@agentic/core` where core has
 * one (`AgentConfig`, `AgentConfigVersion`, `MemoryEntry`); the rest is
 * local until #35 / #41 wire the Agent and Memory actors.
 */
import type { AgentConfig, AgentConfigVersion, AgentId, EnvironmentId, MemoryEntry, MemoryKind, SessionId, TaskId } from '@agentic/core';
import type { AgentHue, EnvironmentParts } from '@agentic/ui';
import { agents, machines, sessions, type MockAgent } from './data';

export type AgentPresence = 'active' | 'waiting' | 'idle';

export interface AgentProfile {
    readonly id: string;
    readonly hue: AgentHue;
    readonly role: string;
    readonly presence: AgentPresence;
    /** The default environment; absent when a `claude-code` agent has none (shows "No environment"). */
    readonly environment?: EnvironmentParts;
    readonly config: AgentConfig;
    readonly versions: readonly AgentConfigVersion[];
    /** A version learning proposed and nobody reviewed yet (rendered NEEDS REVIEW). */
    readonly proposed?: AgentConfigVersion;
    /** Sessions still running on an older version (AGT-07). */
    readonly activeOnOlder: number;
    readonly memories: readonly MemoryEntry[];
    readonly scopes: readonly { readonly scope: string; readonly shared: boolean }[];
    readonly correctionsThisWeek: number;
    readonly repeatedMistakes: number;
    readonly learning: boolean;
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-17T14:20:00Z');
const ago = (days: number, hours = 0): number => NOW - days * DAY - hours * 3_600_000;

function config(partial: Partial<AgentConfig> & Pick<AgentConfig, 'name' | 'description' | 'role' | 'instructions'>): AgentConfig {
    return {
        skills: [],
        tools: [{ name: 'Read' }, { name: 'memory.search' }],
        connectors: [],
        approvalPolicy: [
            { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' },
            { id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }
        ],
        memoryPolicy: { shared: ['agentic-repo'], autoLearn: 'lessons' },
        execution: { runtime: 'anthropic-api', limits: { maxTurns: 40, maxCostUsd: 5, maxDepth: 3 }, offlinePolicy: 'queue' },
        collaborators: 'all',
        ...partial
    };
}

function versions(current: number, by: string, reasons: readonly string[]): AgentConfigVersion[] {
    return reasons.map((reason, i) => ({ version: current - i, at: ago(i + 1, i * 3), by, reason }));
}

function memory(id: string, kind: MemoryKind, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id,
        kind,
        text,
        tags: [],
        provenance: { source: 'user', at: ago(1) },
        confidence: 'stated',
        ...extra
    };
}

const builderMemories: MemoryEntry[] = [
    memory('m1', 'lesson', 'After changing drawer or dialog layout, check that the focus trap still holds when the element collapses.', {
        tags: ['packages/ui', 'layout', 'a11y'],
        conditions: 'packages/ui · layout · a11y',
        provenance: { source: 'user', at: ago(0, 1), messageId: 'msg_47' as never },
        confidence: 'stated'
    }),
    memory('m2', 'lesson', 'Durable Object migrations use new_sqlite_classes. new_classes is irreversible.', {
        tags: ['wrangler', 'cloudflare'],
        conditions: 'wrangler · cloudflare',
        provenance: { source: 'verification', at: ago(1), taskId: 't_5c10' as TaskId },
        confidence: 'verified'
    }),
    memory('m3', 'preference', 'Andy wants one PR per issue, squash merged, with the Verify command output pasted in the description.', {
        provenance: { source: 'user', at: ago(1, 4) },
        confidence: 'stated'
    }),
    memory('m4', 'fact', 'apps/web is the only package allowed to import the sigx umbrella. packages/* peer on runtime-core.', {
        provenance: { source: 'import', at: ago(1, 6) },
        subject: 'docs/architecture.md section 1',
        confidence: 'verified'
    }),
    memory('m5', 'assumption', 'Node 22 global WebSocket works in the daemon on Windows.', {
        tags: ['apps/daemon'],
        conditions: 'apps/daemon',
        provenance: { source: 'agent', at: ago(1, 8), sessionId: 's_3e90' as SessionId },
        confidence: 'assumed'
    }),
    memory('m6', 'record', 'Issue #47 needs the drawer to collapse below 768 px; Lint reviews before any push.', {
        provenance: { source: 'agent', at: ago(2), taskId: 't_8f2c' as TaskId },
        confidence: 'stated'
    }),
    memory('m7', 'lesson', 'Use pnpm link for local sigx checkouts.', {
        provenance: { source: 'user', at: ago(9) },
        confidence: 'stated',
        retired: true,
        supersedes: 'decision 2026-09-17: never link local checkouts'
    })
];

const scoutMemories: MemoryEntry[] = [
    memory('m8', 'fact', 'The A2A 1.0 JSON-RPC spec names the agent card at /.well-known/agent-card.json.', {
        provenance: { source: 'verification', at: ago(3) },
        confidence: 'verified'
    }),
    memory('m9', 'preference', 'Briefs are one page, sourced, no marketing language.', {
        provenance: { source: 'user', at: ago(5) },
        confidence: 'stated'
    })
];

const PROFILES: Record<string, Omit<AgentProfile, 'id'>> = {
    a1: {
        hue: 4,
        role: 'Researcher',
        presence: 'waiting',
        environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' },
        config: config({
            name: 'Scout',
            description: 'Researches a topic and writes a brief.',
            role: 'Researcher',
            instructions: 'Write short, sourced notes.\nName the source for every claim.\nAsk before spending more than one hour.',
            skills: [{ id: 'web-research' }],
            tools: [{ name: 'Read' }, { name: 'WebFetch', mode: 'ask' }, { name: 'ask_user' }],
            connectors: [{ id: 'github' }]
        }),
        versions: versions(4, 'Andy', ['Ask before WebFetch.', 'Added the one-hour rule.', 'Sourced notes only.', 'Created.']),
        activeOnOlder: 0,
        memories: scoutMemories,
        scopes: [{ scope: 'agent:a1', shared: false }, { scope: 'shared:agentic-repo', shared: true }],
        correctionsThisWeek: 0,
        repeatedMistakes: 0,
        learning: true
    },
    a2: {
        hue: 2,
        role: 'Developer',
        presence: 'active',
        environment: { machine: 'andy-desktop', runtime: 'claude-code', account: 'work' },
        config: config({
            name: 'Builder',
            description: 'Implements issues in the repo through Claude Code. Works in worktrees, never on main.',
            role: 'Developer',
            instructions: "Branch first with pnpm wt new. Never commit on main.\nStay inside the owner paths named by the issue.\nRun the issue's Verify command before reporting a result.\nFile zero friction on andtii/zero-wip and link it.",
            skills: [{ id: 'sigx-actors' }, { id: 'zero-anatomy' }, { id: 'git-worktree' }],
            tools: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash', mode: 'ask' }, { name: 'memory.*' }, { name: 'task.report' }, { name: 'ask_user' }],
            connectors: [{ id: 'github' }],
            approvalPolicy: [
                { id: 'category:read', match: { categories: ['read'] }, outcome: 'allow' },
                { id: 'category:write', match: { categories: ['write'] }, outcome: 'allow' },
                { id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' },
                { id: 'category:network', match: { categories: ['network'] }, outcome: 'ask' }
            ],
            execution: {
                runtime: 'claude-code',
                defaultEnvironmentId: 'env_alien01_work' as EnvironmentId,
                limits: { maxTurns: 40, maxWallMs: 3_600_000, maxCostUsd: 5, maxDepth: 3 },
                offlinePolicy: 'queue'
            }
        }),
        versions: versions(11, 'Andy', ['Added the Verify command rule.', 'Tools: added task.report.', 'Destructive moved from allow to ask.', 'Network calls now ask.']),
        proposed: { version: 12, at: ago(0, 2), by: 'learning', reason: 'Learning proposes: "Check the drawer focus trap after layout changes." From your correction in Mobile pass #47.' },
        activeOnOlder: 1,
        memories: builderMemories,
        scopes: [{ scope: 'agent:a2', shared: false }, { scope: 'shared:agentic-repo', shared: true }],
        correctionsThisWeek: 1,
        repeatedMistakes: 0,
        learning: true
    },
    a3: {
        hue: 3,
        role: 'Maintainer',
        presence: 'idle',
        config: config({
            name: 'Janitor',
            description: 'Nightly repo hygiene: deps, lint, flaky tests.',
            role: 'Maintainer',
            instructions: 'Run the nightly checks. Open one PR per fix. Never force-push.',
            tools: [{ name: 'Read' }, { name: 'Bash', mode: 'ask' }],
            // #368: a nightly job resumes a turn its machine cut short on its own, once.
            execution: { runtime: 'claude-code', limits: { maxTurns: 20, maxCostUsd: 1 }, offlinePolicy: 'queue', onInterrupt: 'auto' }
        }),
        versions: versions(2, 'Andy', ['One PR per fix.', 'Created.']),
        activeOnOlder: 0,
        memories: [],
        scopes: [{ scope: 'agent:a3', shared: false }],
        correctionsThisWeek: 0,
        repeatedMistakes: 0,
        learning: false
    }
};

export const agentProfile = (id: string): AgentProfile | undefined => {
    const p = PROFILES[id];
    return p ? { id, ...p } : undefined;
};

/** Every agent with its profile, in workspace order — what the roster lists. */
export const agentProfiles = (): (AgentProfile & { readonly agent: MockAgent })[] =>
    agents.flatMap((agent) => {
        const profile = agentProfile(agent.id);
        return profile ? [{ ...profile, agent }] : [];
    });

export const MEMORY_KINDS: readonly MemoryKind[] = ['lesson', 'preference', 'fact', 'record', 'assumption', 'working'];

/** Count memories by kind (retired ones included: they stay visible). */
export function memoryCounts(entries: readonly MemoryEntry[]): Record<MemoryKind | 'all', number> {
    const counts = { all: entries.length } as Record<MemoryKind | 'all', number>;
    for (const kind of MEMORY_KINDS) counts[kind] = entries.filter((e) => e.kind === kind).length;
    return counts;
}

/** A session row for the agent's Sessions tab (and the Machine page's table): id, environment, status, age. */
export interface SessionRow {
    readonly id: string;
    readonly agentId: string;
    readonly environment: EnvironmentParts;
    readonly status: string;
    readonly startedAt: string;
    readonly turns: number;
}

export function sessionRows(agentId: string): SessionRow[] {
    return sessions
        .filter((s) => s.agentId === agentId)
        .map((s) => {
            const machine = machines.find((m) => m.id === s.machineId);
            return {
                id: s.id,
                agentId: s.agentId,
                environment: { machine: machine?.name ?? s.machineId, runtime: 'claude-code', account: 'work' },
                status: s.status,
                startedAt: s.startedAt,
                turns: s.turns
            };
        });
}

/** Where "agent" ids are needed as the core brand. */
export const asAgentId = (id: string): AgentId => id as AgentId;
