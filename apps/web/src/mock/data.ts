/**
 * Mock data for the route skeleton. Real data (actor state via
 * `useActorState`, transcripts via `Session.tail`) is a later issue; these
 * shapes are deliberately local so nothing here pretends to be a contract.
 */

export type AgentStatus = 'idle' | 'busy' | 'offline';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked';
export type SessionStatus = 'running' | 'done' | 'interrupted' | 'error';

export interface MockAgent {
    id: string;
    name: string;
    description: string;
    runtime: 'claude-code' | 'anthropic-api';
    status: AgentStatus;
    configVersion: number;
}

export interface MockChat {
    id: string;
    title: string;
    agentId: string;
    updatedAt: string;
    preview: string;
}

export interface MockTask {
    id: string;
    title: string;
    agentId: string;
    status: TaskStatus;
    costUsd: number;
    children?: MockTask[];
}

export interface MockSession {
    id: string;
    taskId: string;
    agentId: string;
    machineId: string;
    status: SessionStatus;
    startedAt: string;
    turns: number;
}

export interface MockMachine {
    id: string;
    name: string;
    os: string;
    online: boolean;
    runtimes: string[];
    lastSeen: string;
}

export interface MockSchedule {
    id: string;
    name: string;
    cron: string;
    agentId: string;
    nextRun: string;
    enabled: boolean;
}

export interface MockPlugin {
    id: string;
    name: string;
    kind: 'memory' | 'learning' | 'tool' | 'connector';
    enabled: boolean;
}

export interface MockInboxItem {
    id: string;
    kind: 'approval' | 'mention' | 'done' | 'failed';
    title: string;
    href: string;
    at: string;
}

export const agents: MockAgent[] = [
    { id: 'a1', name: 'Scout', description: 'Researches a topic and writes a brief.', runtime: 'anthropic-api', status: 'idle', configVersion: 4 },
    { id: 'a2', name: 'Builder', description: 'Implements issues in the repo through Claude Code.', runtime: 'claude-code', status: 'busy', configVersion: 11 },
    { id: 'a3', name: 'Janitor', description: 'Nightly repo hygiene: deps, lint, flaky tests.', runtime: 'claude-code', status: 'offline', configVersion: 2 }
];

export const chats: MockChat[] = [
    { id: 'c1', title: 'Release notes for 0.3', agentId: 'a1', updatedAt: '2026-09-17T08:12:00Z', preview: 'Here is the draft grouped by area…' },
    { id: 'c2', title: 'Fix the flaky drawer test', agentId: 'a2', updatedAt: '2026-09-17T07:40:00Z', preview: 'I found the race: the panel opens before…' },
    { id: 'c3', title: 'Plan the schedule actor', agentId: 'a1', updatedAt: '2026-09-16T18:05:00Z', preview: 'Three options; I recommend the alarm-based…' }
];

export const tasks: MockTask[] = [
    {
        id: 't1', title: 'Ship the app shell', agentId: 'a2', status: 'running', costUsd: 1.42,
        children: [
            { id: 't1-1', title: 'Scaffold apps/web', agentId: 'a2', status: 'done', costUsd: 0.31 },
            { id: 't1-2', title: 'Layout tier on data-l-*', agentId: 'a2', status: 'done', costUsd: 0.44 },
            { id: 't1-3', title: 'Playwright smoke', agentId: 'a2', status: 'running', costUsd: 0.67 }
        ]
    },
    { id: 't2', title: 'Write the 0.3 release notes', agentId: 'a1', status: 'blocked', costUsd: 0.12 },
    { id: 't3', title: 'Nightly hygiene 2026-09-16', agentId: 'a3', status: 'failed', costUsd: 0.05 }
];

export const sessions: MockSession[] = [
    { id: 's1', taskId: 't1-3', agentId: 'a2', machineId: 'm1', status: 'running', startedAt: '2026-09-17T08:02:00Z', turns: 14 },
    { id: 's2', taskId: 't1-2', agentId: 'a2', machineId: 'm1', status: 'done', startedAt: '2026-09-17T06:30:00Z', turns: 22 },
    { id: 's3', taskId: 't3', agentId: 'a3', machineId: 'm2', status: 'error', startedAt: '2026-09-16T23:00:00Z', turns: 3 }
];

export const machines: MockMachine[] = [
    { id: 'm1', name: 'andy-desktop', os: 'Windows 11', online: true, runtimes: ['claude-code', 'copilot-cli'], lastSeen: '2026-09-17T08:14:00Z' },
    { id: 'm2', name: 'build-box', os: 'Ubuntu 24.04', online: false, runtimes: ['claude-code'], lastSeen: '2026-09-16T23:05:00Z' }
];

export const schedules: MockSchedule[] = [
    { id: 'sch1', name: 'Nightly hygiene', cron: '0 2 * * *', agentId: 'a3', nextRun: '2026-09-18T02:00:00Z', enabled: true },
    { id: 'sch2', name: 'Weekly digest', cron: '0 9 * * 1', agentId: 'a1', nextRun: '2026-09-21T09:00:00Z', enabled: false }
];

export const plugins: MockPlugin[] = [
    { id: 'p1', name: 'Default memory', kind: 'memory', enabled: true },
    { id: 'p2', name: 'Default learning', kind: 'learning', enabled: true },
    { id: 'p3', name: 'GitHub MCP', kind: 'connector', enabled: false }
];

export const inbox: MockInboxItem[] = [
    { id: 'i1', kind: 'approval', title: 'Builder wants to run `pnpm publish`', href: '/sessions/s1', at: '2026-09-17T08:10:00Z' },
    { id: 'i2', kind: 'failed', title: 'Nightly hygiene 2026-09-16 failed', href: '/tasks/t3', at: '2026-09-16T23:06:00Z' },
    { id: 'i3', kind: 'done', title: 'Layout tier on data-l-* is done', href: '/tasks/t1-1', at: '2026-09-17T07:55:00Z' }
];

export const agentById = (id: string) => agents.find(a => a.id === id);
export const chatById = (id: string) => chats.find(c => c.id === id);
export const machineById = (id: string) => machines.find(m => m.id === id);
export const sessionById = (id: string) => sessions.find(s => s.id === id);

/** Find a task anywhere in the tree. */
export function taskById(id: string, list: MockTask[] = tasks): MockTask | undefined {
    for (const t of list) {
        if (t.id === id) return t;
        const hit = t.children && taskById(id, t.children);
        if (hit) return hit;
    }
    return undefined;
}

/** The mock `:id` for every parameterised route — what a smoke test navigates to. */
export const sampleIds = { chat: 'c1', agent: 'a1', task: 't1', session: 's1', machine: 'm1' } as const;
