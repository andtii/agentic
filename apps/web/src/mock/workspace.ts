/**
 * The mock workspace the core-flow pages read, in core vocabulary
 * (`TaskStatus`, `WaitReason`, environment descriptors, `CapabilityReport`).
 * The sample names are the artboards' (docs/design/HANDOFF.md): agents
 * Atlas, Forge, Lint, Scout; machines alien01, nuc-lab and the platform.
 *
 * One `load*()` per page returns that page's view model. #34 / #40 / #39
 * replace the body of each loader with actor reads; the pages keep the
 * shape. Nothing here is a contract beyond `@agentic/core`'s types.
 */
import type { AuthStatus, CapabilityReport, EnvironmentId, MachineId, ProjectId, ProjectRecord, SessionId, TaskId, TaskStatus, WaitReason, WorkdirRef } from '@agentic/core';
import { createTranscript } from '@sigx/ai-agent';
import type { AgentTranscript, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import type { AgentHue, ApprovalContext, EnvironmentParts, MessageAuthor, Recipient } from '@agentic/ui';

/** The workspace clock: every mock time is relative to this instant, so ages are stable. */
export const MOCK_NOW = Date.parse('2026-09-17T12:16:00Z');
/** The workspace time zone (AST-07): every time on a screen renders in it. */
export const TIME_ZONE = 'Europe/Stockholm';

export interface MockAgentIdentity {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly hue: AgentHue;
    /** Where this agent's sessions run (EXE-06: all three parts, always). */
    readonly environment: EnvironmentParts;
    readonly environmentId: EnvironmentId;
    readonly configVersion: number;
}

export const AGENTS: readonly MockAgentIdentity[] = [
    { id: 'atlas', name: 'Atlas', role: 'Personal assistant', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, environmentId: 'env_platform' as EnvironmentId, configVersion: 12 },
    { id: 'forge', name: 'Forge', role: 'Developer', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, environmentId: 'env_alien01_work' as EnvironmentId, configVersion: 7 },
    { id: 'lint', name: 'Lint', role: 'Reviewer', hue: 3, environment: { machine: 'alien01', runtime: 'claude-code', account: 'personal' }, environmentId: 'env_alien01_personal' as EnvironmentId, configVersion: 3 },
    { id: 'scout', name: 'Scout', role: 'Researcher', hue: 4, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, environmentId: 'env_platform' as EnvironmentId, configVersion: 5 }
];

export const agentNamed = (id: string): MockAgentIdentity => {
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) throw new Error(`mock: no agent ${id}`);
    return agent;
};

/** The person using the workspace. */
export const USER = { name: 'Andii', workspace: 'ws:andtii' } as const;

// ---- tasks ---------------------------------------------------------------

export interface MockTaskRow {
    readonly id: TaskId;
    /** The short ref the artboards print (`t_8f2c`). */
    readonly ref: string;
    readonly objective: string;
    readonly agentId: string;
    readonly status: TaskStatus;
    readonly wait?: WaitReason;
    /** What the wait is about, when known (`git push`). */
    readonly waitDetail?: string;
    readonly environment: EnvironmentParts;
    readonly createdAt: number;
    readonly parentId?: TaskId;
    readonly chatId?: string;
    readonly sessionId?: SessionId;
    readonly depth: number;
}

const minutesAgo = (m: number): number => MOCK_NOW - m * 60_000;
const hoursAgo = (h: number): number => MOCK_NOW - h * 3_600_000;

const tid = (s: string): TaskId => s as TaskId;
const sid = (s: string): SessionId => s as SessionId;

export const TASKS: readonly MockTaskRow[] = [
    {
        id: tid('t1'), ref: 't_8f2b', objective: 'Coordinate the mobile pass for issue #47', agentId: 'atlas', status: 'waiting',
        wait: { kind: 'child', childTaskIds: [tid('t1-1'), tid('t1-2')] }, environment: agentNamed('atlas').environment,
        createdAt: minutesAgo(15), chatId: 'c1', sessionId: sid('s2'), depth: 0
    },
    {
        id: tid('t1-1'), ref: 't_8f2c', objective: 'Make the drawer collapse below 768 px in shell.css', agentId: 'forge', status: 'waiting',
        wait: { kind: 'approval', requestId: 'r_5d01', sessionId: sid('s1') }, waitDetail: 'git push', environment: agentNamed('forge').environment,
        createdAt: minutesAgo(14), parentId: tid('t1'), chatId: 'c1', sessionId: sid('s1'), depth: 1
    },
    {
        id: tid('t1-2'), ref: 't_8f2d', objective: "Review Forge's shell.css change against zero anatomy", agentId: 'lint', status: 'active',
        environment: agentNamed('lint').environment, createdAt: minutesAgo(3), parentId: tid('t1'), chatId: 'c1', sessionId: sid('s4'), depth: 1
    },
    {
        id: tid('t2'), ref: 't_77b1', objective: 'Summarise which A2A clients exist today', agentId: 'scout', status: 'waiting',
        wait: { kind: 'input', requestId: 'r_77b1', sessionId: sid('s5') }, environment: agentNamed('scout').environment,
        createdAt: minutesAgo(21), chatId: 'c2', sessionId: sid('s5'), depth: 0
    },
    {
        id: tid('t3'), ref: 't_90aa', objective: 'Nightly dependency audit', agentId: 'forge', status: 'queued',
        wait: { kind: 'environment-offline', environmentId: 'env_nuclab_work' as EnvironmentId, policy: 'queue' }, environment: { machine: 'nuc-lab', runtime: 'claude-code', account: 'work' },
        createdAt: hoursAgo(3), depth: 0
    },
    {
        id: tid('t4'), ref: 't_61c0', objective: 'Weekly summary to inbox', agentId: 'atlas', status: 'completed',
        environment: agentNamed('atlas').environment, createdAt: hoursAgo(26), chatId: 'c3', sessionId: sid('s3'), depth: 0
    }
];

export const taskRow = (id: string): MockTaskRow | undefined => TASKS.find((t) => t.id === id);
/** The chain a task belongs to: its root's id. */
export const rootOf = (task: MockTaskRow): MockTaskRow => (task.parentId ? rootOf(taskRow(task.parentId)!) : task);
export const childrenOf = (id: TaskId): MockTaskRow[] => TASKS.filter((t) => t.parentId === id);
/** Every task in the chain rooted at `id`, in tree order. */
export function treeOf(id: TaskId): MockTaskRow[] {
    const root = taskRow(id);
    if (!root) return [];
    const out: MockTaskRow[] = [];
    const walk = (t: MockTaskRow): void => {
        out.push(t);
        for (const c of childrenOf(t.id)) walk(c);
    };
    walk(root);
    return out;
}
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'active', 'waiting'];
export const isActive = (t: MockTaskRow): boolean => ACTIVE_STATUSES.includes(t.status);

// ---- inbox (what needs a person) ----------------------------------------

export type NeedsKindMock = 'approval' | 'input' | 'interrupted';

export interface MockNeedsItem {
    readonly id: string;
    readonly kind: NeedsKindMock;
    readonly title: string;
    readonly agentId: string;
    readonly at: number;
    readonly context: string;
    readonly environment?: EnvironmentParts;
    /** The approval request behind an `approval` item. */
    readonly request?: OpenRequest;
    readonly approval?: ApprovalContext;
    readonly href: string;
    readonly hrefLabel: string;
    /** A second link (Open task / Open session). */
    readonly primary?: { label: string };
}

const PUSH_REQUEST: OpenRequest = { requestId: 'r_5d01', kind: 'permission', callId: 'c_push', toolName: 'Bash', message: 'git push origin 47-mobile-drawer', permissionKey: 'Bash:git push', seq: 318 };
const PUSH_CONTEXT: ApprovalContext = {
    toolName: 'Bash',
    input: { command: 'git push origin 47-mobile-drawer' },
    rule: 'ask on destructive',
    requestedBy: { name: 'Forge', hue: 2 },
    environment: agentNamed('forge').environment,
    via: 'delegated by Atlas · task t_8f2c · depth 1'
};

export const NEEDS: readonly MockNeedsItem[] = [
    { id: 'n2', kind: 'input', title: 'Scout asks: which A2A clients should the interop note cover?', agentId: 'scout', at: minutesAgo(18), context: 'ask_user · task t_77b1 · chat "A2A landscape"', href: '/tasks/t2', hrefLabel: 'Open task', primary: { label: 'Answer' } },
    { id: 'n1', kind: 'approval', title: 'Forge wants to run git push origin 47-mobile-drawer', agentId: 'forge', at: minutesAgo(2), context: 'delegated by Atlas', environment: agentNamed('forge').environment, request: PUSH_REQUEST, approval: PUSH_CONTEXT, href: '/chats/c1', hrefLabel: 'Open chat' },
    { id: 'n3', kind: 'interrupted', title: 'Atlas was interrupted mid-turn while drafting the weekly summary', agentId: 'atlas', at: minutesAgo(18), context: 'The platform restarted the session. Nothing was replayed. The transcript is intact.', href: '/sessions/s3', hrefLabel: 'Open session', primary: { label: 'Resume' } }
];

const NEEDS_ORDER: Record<NeedsKindMock, number> = { approval: 0, input: 1, interrupted: 2 };
/** Approvals first, then input, then interrupted; oldest first inside each kind (docs/design/HANDOFF.md → Home). */
export function sortNeeds(items: readonly MockNeedsItem[]): MockNeedsItem[] {
    return [...items].sort((a, b) => NEEDS_ORDER[a.kind] - NEEDS_ORDER[b.kind] || a.at - b.at);
}

// ---- chats ----------------------------------------------------------------

export interface MockChatMember {
    readonly agentId: string;
    readonly status: TaskStatus | 'idle';
    readonly coordinator?: boolean;
    /** CHT-04: what the member may read. */
    readonly history: { readonly access: 'all' } | { readonly access: 'from'; readonly at: number };
    /** The folder this agent works in for this chat (`Chat.setWorkdir`, #193); absent: its default. */
    readonly workdir?: WorkdirRef;
}

export interface MockChatSummary {
    readonly id: string;
    readonly title: string;
    readonly members: readonly MockChatMember[];
    readonly lastLine: string;
    readonly unread: number;
    /** An approval is open in this chat (amber pill on the row). */
    readonly waiting: boolean;
    readonly updatedAt: number;
    /** The project the chat belongs to (#333, `Chat.setProject`); absent when it is in none. */
    readonly projectId?: string;
}

// ---- projects (#333) ------------------------------------------------------

const pid = (s: string): ProjectId => s as ProjectId;
const eid = (s: string): EnvironmentId => s as EnvironmentId;

/**
 * The workspace's projects: "agentic" lives on two environments with the git
 * feature on, "docs-site" on one. A chat in a project inherits the project's
 * folder for each member's environment.
 */
export const PROJECTS: readonly ProjectRecord[] = [
    {
        id: pid('p_agentic'),
        name: 'agentic',
        description: 'The Unified Agent Platform monorepo.',
        members: { agentIds: ['forge', 'lint', 'atlas'] as never[], coordinator: 'atlas' as never },
        folders: { [eid('env_alien01_work')]: 'C:\\Dev\\agentic\\main', [eid('env_alien01_personal')]: 'C:\\Users\\andy\\src\\agentic' },
        connectors: [{ id: 'github-mcp' }],
        features: { 'agentic.feature.git': { origin: 'https://github.com/andtii/agentic.git', worktrees: true } },
        createdAt: hoursAgo(72),
        updatedAt: hoursAgo(2)
    },
    {
        id: pid('p_docs'),
        name: 'docs-site',
        members: { agentIds: ['scout'] as never[], coordinator: null },
        folders: { [eid('env_alien01_personal')]: 'C:\\Users\\andy\\src\\blog' },
        connectors: [],
        features: {},
        createdAt: hoursAgo(48),
        updatedAt: hoursAgo(48)
    }
];

export const projectNamed = (id: string): ProjectRecord | undefined => PROJECTS.find((p) => p.id === id);

/** The project the New chat picker preselects on mock data: the one used last. */
export const LAST_PROJECT_ID: string = 'p_agentic';

export const CHATS: readonly MockChatSummary[] = [
    { id: 'c1', title: 'Mobile pass #47', members: [{ agentId: 'atlas', status: 'waiting', coordinator: true, history: { access: 'all' } }, { agentId: 'forge', status: 'waiting', history: { access: 'all' } }, { agentId: 'lint', status: 'active', history: { access: 'from', at: minutesAgo(14) } }], lastLine: 'Forge is waiting for approval', unread: 1, waiting: true, updatedAt: minutesAgo(2) },
    { id: 'c2', title: 'A2A landscape', members: [{ agentId: 'scout', status: 'waiting', history: { access: 'all' } }], lastLine: 'Scout asked a question', unread: 1, waiting: false, updatedAt: minutesAgo(18), projectId: 'p_docs' },
    { id: 'c3', title: 'Atlas', members: [{ agentId: 'atlas', status: 'idle', coordinator: true, history: { access: 'all' } }], lastLine: 'Weekly summary interrupted', unread: 0, waiting: false, updatedAt: minutesAgo(18) },
    { id: 'c4', title: 'Release checklist', members: [{ agentId: 'forge', status: 'idle', history: { access: 'all' } }, { agentId: 'lint', status: 'idle', history: { access: 'all' } }], lastLine: 'Lint: runbook section 3 reads fine now', unread: 0, waiting: false, updatedAt: hoursAgo(5), projectId: 'p_agentic' },
    { id: 'c5', title: 'Field service event', members: [{ agentId: 'atlas', status: 'idle', coordinator: true, history: { access: 'all' } }], lastLine: 'Reminder set for 15:00', unread: 0, waiting: false, updatedAt: hoursAgo(27) },
    { id: 'c6', title: 'Empty chat', members: [{ agentId: 'scout', status: 'idle', history: { access: 'all' } }], lastLine: '', unread: 0, waiting: false, updatedAt: hoursAgo(30) }
];

export const chatSummary = (id: string): MockChatSummary | undefined => CHATS.find((c) => c.id === id);

/** The transcript view of a chat: the messages, who wrote each, what each tool call's meta is, and the approval context. */
export interface MockChatView {
    readonly chat: MockChatSummary;
    readonly transcript: AgentTranscript;
    readonly authors: Readonly<Record<string, MessageAuthor>>;
    readonly toolMeta: Readonly<Record<string, string>>;
    readonly approvals: Readonly<Record<string, ApprovalContext>>;
    readonly tasks: readonly MockTaskRow[];
    /** The session log the thread's long outputs link to. */
    readonly logHref?: string;
}

const tool = (callId: string, name: string, input: unknown, extra: Partial<ToolPartState> = {}): ToolPartState => ({ type: 'tool', callId, name, status: 'completed', input, ...extra });

const at = (minutes: number): MessageAuthor['time'] => {
    const ms = minutesAgo(minutes);
    return { text: formatTime(ms), dateTime: new Date(ms).toISOString() };
};

const authorFor = (agentId: string, minutes: number): MessageAuthor => {
    const a = agentNamed(agentId);
    return { name: a.name, hue: a.hue, environment: a.environment, time: at(minutes) };
};

function mobilePassTranscript(): Omit<MockChatView, 'chat' | 'tasks'> {
    const transcript = createTranscript('s_chat_c1');
    transcript.messages.push(
        { id: 'm1', role: 'user', author: USER.name, parts: [{ type: 'text', text: '@Atlas issue #47 needs the drawer to collapse below 768 px. Get Forge on it and have Lint review before anything is pushed.' }] },
        {
            id: 'm2', role: 'assistant', actor: 'atlas', parts: [
                { type: 'text', id: 'p2', text: 'On it. I’m delegating the change to Forge and a review to Lint. The push stays behind your approval rule.' },
                tool('c_03', 'delegate', { agent: 'Forge', objective: 'Make the drawer collapse below 768 px in shell.css' }, { output: 't_8f2c' }),
                tool('c_04', 'delegate', { agent: 'Lint', objective: "Review Forge's shell.css change against zero anatomy" }, { status: 'in_progress' })
            ]
        },
        {
            id: 'm3', role: 'assistant', actor: 'forge', parts: [
                { type: 'text', id: 'p3', text: 'The drawer used a fixed 232 px column. I moved it to a `data-l-drawer` state and collapse it under 768 px. Tests pass locally.' },
                tool('c_edit', 'Edit', { file: 'packages/ui/src/shell/shell.css' }, { output: 'ok' }),
                tool('c_test', 'Bash', { command: 'pnpm test packages/ui' }, { output: '42 passed · 0 failed · 3.1s' }),
                tool('c_push', 'Bash', { command: 'git push origin 47-mobile-drawer' }, { status: 'pending', requestId: 'r_5d01' })
            ]
        },
        {
            id: 'm4', role: 'assistant', actor: 'lint', parts: [
                { type: 'reasoning', id: 'p4r', text: 'Checking the diff against the drawer anatomy.', done: true },
                { type: 'text', id: 'p4', text: 'Reading the diff now. The breakpoint is right, but the drawer loses its focus trap when it collapses, so keyboard users can tab behind the' }
            ]
        }
    );
    transcript.requests[PUSH_REQUEST.requestId] = PUSH_REQUEST;
    // Lint is mid-turn: the last assistant row carries the STREAMING pill.
    transcript.state = 'running';
    return {
        transcript,
        authors: { m1: { name: USER.name, person: true, time: at(14) }, m2: authorFor('atlas', 14), m3: authorFor('forge', 7), m4: authorFor('lint', 4) },
        toolMeta: { c_03: 't_8f2c', c_04: 't_8f2d', c_edit: '+18 −6', c_test: '3.4s' },
        approvals: { r_5d01: PUSH_CONTEXT },
        logHref: '/sessions/s1'
    };
}

function a2aTranscript(): Omit<MockChatView, 'chat' | 'tasks'> {
    const transcript = createTranscript('s_chat_c2');
    const ask: OpenRequest = { requestId: 'r_77b1', kind: 'input', toolName: 'ask_user', message: 'Which A2A clients should the interop note cover?', seq: 12 };
    transcript.messages.push(
        { id: 'm1', role: 'user', author: USER.name, parts: [{ type: 'text', text: 'Write a short note on the A2A client landscape for the interop section.' }] },
        { id: 'm2', role: 'assistant', actor: 'scout', parts: [{ type: 'text', id: 'p2', text: 'Before I list them: which A2A clients should the interop note cover — every 1.0 client, or the ones we can test against?' }] }
    );
    transcript.requests[ask.requestId] = ask;
    transcript.state = 'awaiting';
    return { transcript, authors: { m1: { name: USER.name, person: true, time: at(21) }, m2: authorFor('scout', 18) }, toolMeta: {}, approvals: {} };
}

function plainTranscript(id: string, agentId: string, minutes: number, text: string): Omit<MockChatView, 'chat' | 'tasks'> {
    const transcript = createTranscript(`s_chat_${id}`);
    if (text) transcript.messages.push({ id: 'm1', role: 'assistant', actor: agentId, parts: [{ type: 'text', id: 'p1', text }] });
    return { transcript, authors: text ? { m1: authorFor(agentId, minutes) } : {}, toolMeta: {}, approvals: {} };
}

// ---- sessions ---------------------------------------------------------------

export interface MockEvent {
    readonly seq: number;
    readonly kind: 'tool-call' | 'tool-result' | 'text' | 'request' | 'turn-end' | 'error';
    readonly text: string;
}

export interface MockSessionView {
    readonly id: SessionId;
    readonly ref: string;
    readonly agentId: string;
    readonly state: 'running' | 'awaiting' | 'idle' | 'disconnected' | 'error' | 'closed';
    readonly openedAt: number;
    readonly openedFrom: string;
    readonly chatId?: string;
    readonly taskId?: TaskId;
    readonly environment: EnvironmentParts;
    readonly machine: { readonly id: MachineId; readonly name: string; readonly os: string; readonly online: boolean };
    readonly runtimeVersion: string;
    readonly authStatus: 'auth-ok' | 'auth-expired' | 'auth-missing';
    readonly cwd: string;
    readonly head: { readonly epoch: number; readonly seq: number };
    readonly configVersion: number;
    /** The current tool call and the open request, if any. */
    readonly current?: { readonly part: ToolPartState; readonly transcript: AgentTranscript; /** The call's duration as the tool row prints it; the platform reports none (#154). */ readonly meta?: string };
    readonly request?: { readonly request: OpenRequest; readonly context: ApprovalContext };
    readonly events: readonly MockEvent[];
    /** Events lost across a reconnect, if any. */
    readonly gap?: { readonly from: number; readonly to: number };
    readonly capabilities: CapabilityReport;
    readonly grants: readonly { readonly key: string; readonly label: string }[];
    /** OPS-05: the last event is not `turn-end`. */
    readonly interrupted?: boolean;
    /** OPS-04: the last non-recoverable adapter `error` event — the runtime failed. */
    readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
    /** The machine's word on the environment's account (`authStatus`), when the machine record was read. */
    readonly auth?: { readonly status: AuthStatus; readonly account?: string };
}

const FORGE_CAPABILITIES: CapabilityReport = {
    runtime: 'claude-code',
    supported: ['resume', 'cancel', 'approvals', 'steer'],
    unsupported: [
        { op: 'usage', reason: 'not reported by provider' },
        { op: 'migrate', reason: 'not supported' }
    ],
    resume: 'local',
    cancel: true,
    steer: true,
    permissions: 'every-call',
    tools: 'native'
};

/** What each capability op means on the screen (AC-15: unsupported rows are listed, their controls never rendered). */
export const CAPABILITY_LABELS: Readonly<Record<string, { readonly label: string; readonly note?: string }>> = {
    resume: { label: 'Resume after restart' },
    cancel: { label: 'Cancel a running turn' },
    approvals: { label: 'Approvals', note: 'per tool call' },
    steer: { label: 'Follow-up while running', note: 'queued to next turn' },
    usage: { label: 'Usage and cost' },
    migrate: { label: 'Live migration to another machine' }
};

const ALIEN01 = { id: 'm1' as MachineId, name: 'alien01', os: 'Windows 11', online: true };
const PLATFORM = { id: 'm0' as MachineId, name: 'platform', os: 'Cloudflare', online: true };

function forgeSession(): MockSessionView {
    const transcript = createTranscript('s1');
    transcript.requests[PUSH_REQUEST.requestId] = PUSH_REQUEST;
    transcript.state = 'awaiting';
    return {
        id: sid('s1'), ref: 's_41aa', agentId: 'forge', state: 'awaiting', openedAt: minutesAgo(14), openedFrom: 'chat "Mobile pass #47"', chatId: 'c1', taskId: tid('t1-1'),
        environment: agentNamed('forge').environment, machine: ALIEN01, runtimeVersion: 'claude-code 2.4', authStatus: 'auth-ok',
        cwd: 'C:\\Dev\\agentic\\branches\\47-mobile-drawer', head: { epoch: 1, seq: 318 }, configVersion: 7,
        current: { part: tool('c_test', 'Bash', { command: 'pnpm test packages/ui' }, { output: '42 passed · 0 failed · 3.1s' }), transcript, meta: '3.4s' },
        request: { request: PUSH_REQUEST, context: { ...PUSH_CONTEXT, compact: true } },
        events: [
            { seq: 309, kind: 'tool-call', text: 'Edit packages/ui/src/shell/shell.css' },
            { seq: 310, kind: 'tool-result', text: 'ok +18 -6' },
            { seq: 311, kind: 'text', text: 'The drawer used a fixed 232 px column...' },
            { seq: 314, kind: 'tool-call', text: 'Bash pnpm test packages/ui' },
            { seq: 316, kind: 'tool-result', text: '42 passed, 0 failed' },
            { seq: 317, kind: 'tool-call', text: 'Bash git push origin 47-mobile-drawer' },
            { seq: 318, kind: 'request', text: 'approval r_5d01 scope=once' }
        ],
        gap: { from: 312, to: 314 },
        capabilities: FORGE_CAPABILITIES,
        grants: [
            { key: 'Bash:pnpm test *', label: 'Bash  pnpm test *' },
            { key: 'Edit:packages/ui/**', label: 'Edit  packages/ui/**' }
        ]
    };
}

export const API_CAPABILITIES: CapabilityReport = {
    runtime: 'anthropic-api', supported: ['resume', 'cancel', 'approvals', 'usage'], unsupported: [{ op: 'steer', reason: 'the model runs one turn at a time' }, { op: 'migrate', reason: 'not supported' }],
    resume: 'portable', cancel: true, steer: false, permissions: 'every-call', tools: 'native'
};

function atlasInterruptedSession(): MockSessionView {
    return {
        id: sid('s3'), ref: 's_2c19', agentId: 'atlas', state: 'idle', openedAt: hoursAgo(1), openedFrom: 'schedule "Weekly summary"', chatId: 'c3', taskId: tid('t4'),
        environment: agentNamed('atlas').environment, machine: PLATFORM, runtimeVersion: 'anthropic-api · claude-sonnet-5', authStatus: 'auth-ok',
        cwd: '—', head: { epoch: 2, seq: 41 }, configVersion: 12,
        events: [
            { seq: 39, kind: 'text', text: 'Drafting the weekly summary from 14 completed tasks…' },
            { seq: 40, kind: 'tool-call', text: 'Read inbox digest' },
            { seq: 41, kind: 'tool-result', text: '14 tasks, 3 chats' }
        ],
        capabilities: API_CAPABILITIES, grants: [], interrupted: true
    };
}

function session(id: string, ref: string, agentId: string, taskId: TaskId, state: MockSessionView['state'], minutes: number, chatId: string): MockSessionView {
    const a = agentNamed(agentId);
    const platform = a.environment.machine === 'platform';
    return {
        id: sid(id), ref, agentId, state, openedAt: minutesAgo(minutes), openedFrom: `chat "${chatSummary(chatId)?.title ?? chatId}"`, chatId, taskId,
        environment: a.environment, machine: platform ? PLATFORM : ALIEN01, runtimeVersion: platform ? 'anthropic-api · claude-sonnet-5' : 'claude-code 2.4', authStatus: 'auth-ok',
        cwd: platform ? '—' : 'C:\\Dev\\agentic\\main', head: { epoch: 1, seq: 20 }, configVersion: a.configVersion,
        events: [{ seq: 19, kind: 'text', text: 'Working…' }, { seq: 20, kind: 'turn-end', text: 'stop: end_turn' }],
        capabilities: platform ? API_CAPABILITIES : FORGE_CAPABILITIES, grants: []
    };
}

const SESSIONS: readonly MockSessionView[] = [
    forgeSession(),
    session('s2', 's_1a00', 'atlas', tid('t1'), 'awaiting', 15, 'c1'),
    atlasInterruptedSession(),
    session('s4', 's_41ab', 'lint', tid('t1-2'), 'running', 3, 'c1'),
    session('s5', 's_77b1', 'scout', tid('t2'), 'awaiting', 21, 'c2')
];

// ---- schedule and spend ------------------------------------------------------

export interface MockScheduleToday {
    readonly time: string;
    readonly title: string;
    readonly agentId?: string;
}

export const TODAY: readonly MockScheduleToday[] = [
    { time: '15:00', title: 'Call the venue about the field service event' },
    { time: '17:30', title: 'Weekly summary to inbox', agentId: 'atlas' },
    { time: '02:00', title: 'Nightly dependency audit', agentId: 'forge' }
];

export const SPEND = { monthUsd: 18.42, limitUsd: 50, note: 'anthropic-api only. Claude Code usage is not reported by the provider.' } as const;

// ---- formatting ---------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** `14:02` in the workspace zone. */
export const formatTime = (ms: number): string => timeFmt.format(ms);
/** `16 Sep 14:02` in the workspace zone. */
export const formatDateTime = (ms: number): string => dateTimeFmt.format(ms);

/**
 * A relative age (`14m`, `3h`) that switches to a date after 24 h
 * (docs/design/HANDOFF.md → Edge cases, time zones).
 */
export function formatAge(ms: number, now = MOCK_NOW): string {
    const delta = Math.max(0, now - ms);
    const minutes = Math.round(delta / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return dateFmt.format(ms);
}

// ---- loaders: one per page -------------------------------------------------------

export interface HomeView {
    readonly needs: readonly MockNeedsItem[];
    readonly tasks: readonly MockTaskRow[];
    readonly today: readonly MockScheduleToday[];
    readonly spend: typeof SPEND;
    readonly timeZone: string;
    readonly now: number;
    /** No agents yet: the one "Create your first agent" card. */
    readonly empty: boolean;
}

/** `/` — what needs a person, today's schedule, the month's spend, every active task. */
export function loadHome(): HomeView {
    return { needs: sortNeeds(NEEDS), tasks: TASKS.filter(isActive), today: TODAY, spend: SPEND, timeZone: TIME_ZONE, now: MOCK_NOW, empty: AGENTS.length === 0 };
}

/** `/chats` and the chat page's list column. */
export function loadChats(): readonly MockChatSummary[] {
    return [...CHATS].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** `/chats/:id` — the chat, its transcript view and the tasks it spawned. */
export function loadChat(id: string): MockChatView | undefined {
    const chat = chatSummary(id);
    if (!chat) return undefined;
    const tasks = TASKS.filter((t) => t.chatId === id);
    switch (id) {
        case 'c1':
            return { chat, tasks, ...mobilePassTranscript() };
        case 'c2':
            return { chat, tasks, ...a2aTranscript() };
        case 'c3':
            return { chat, tasks, ...plainTranscript(id, 'atlas', 60, 'Drafting the weekly summary now.') };
        case 'c4':
            return { chat, tasks, ...plainTranscript(id, 'lint', 300, 'Runbook section 3 reads fine now.') };
        case 'c5':
            return { chat, tasks, ...plainTranscript(id, 'atlas', 27 * 60, 'Reminder set for 15:00.') };
        default:
            return { chat, tasks, ...plainTranscript(id, chat.members[0]?.agentId ?? 'atlas', 0, '') };
    }
}

/** `/tasks` — every task, newest first. */
export function loadTasks(): readonly MockTaskRow[] {
    return [...TASKS].sort((a, b) => b.createdAt - a.createdAt);
}

export interface TaskView {
    readonly task: MockTaskRow;
    readonly root: MockTaskRow;
    readonly tree: readonly MockTaskRow[];
    readonly maxDepth: number;
    /** An open approval for a node in the chain, keyed by task id. */
    readonly approvals: Readonly<Record<string, { readonly request: OpenRequest; readonly context: ApprovalContext }>>;
    readonly contracts: Readonly<Record<string, TaskContract>>;
    readonly transitions: Readonly<Record<string, readonly Transition[]>>;
    readonly results: Readonly<Record<string, { readonly verified: boolean; readonly text: string }>>;
    /** COL-12: children that did not ack the stop. */
    readonly notStopped: readonly MockTaskRow[];
}

export interface Transition {
    readonly id: string;
    readonly text: string;
    readonly at: number;
    readonly tone: 'muted' | 'working' | 'needs-you' | 'failed' | 'live' | 'dim';
}

export interface TaskContract {
    readonly ref: string;
    readonly objective: string;
    readonly origin: string;
    /** Who created the task: the delegating agent's id, or `undefined` for the person. */
    readonly originAgentId?: string;
    readonly assigneeId: string;
    readonly environment: EnvironmentParts;
    readonly constraints: string;
    readonly expected: string;
    readonly config: string;
    readonly limits: string;
}

const contractOf = (t: MockTaskRow): TaskContract => ({
    ref: t.ref,
    objective: t.objective,
    origin: t.parentId ? `${agentNamed(taskRow(t.parentId)!.agentId).name} · delegate call c_03 · from your message at ${formatTime(minutesAgo(14))}` : `your message at ${formatTime(t.createdAt)}`,
    originAgentId: t.parentId ? taskRow(t.parentId)!.agentId : undefined,
    assigneeId: t.agentId,
    environment: t.environment,
    constraints: 'Owner paths packages/ui/**. No push without approval. Policy inherited from Atlas, never wider.',
    expected: 'Branch with passing tests and a one-paragraph summary',
    config: `${agentNamed(t.agentId).name} v${agentNamed(t.agentId).configVersion}`,
    limits: '12 of 40 turns · 14m of 60m · budget split $5.00'
});

/** `/tasks/:id` — the chain the task belongs to, with a contract, transitions and result per node. */
export function loadTask(id: string): TaskView | undefined {
    const task = taskRow(id);
    if (!task) return undefined;
    const root = rootOf(task);
    const tree = treeOf(root.id);
    const contracts: Record<string, TaskContract> = {};
    const transitions: TaskView['transitions'] = Object.fromEntries(
        tree.map((t) => {
            const rows: Transition[] = [{ id: `${t.id}-q`, text: `queued · created by ${t.parentId ? agentNamed(taskRow(t.parentId)!.agentId).name : 'you'}`, at: t.createdAt, tone: 'muted' as const }];
            if (t.status !== 'queued') rows.push({ id: `${t.id}-a`, text: `active · session ${SESSIONS.find((s) => s.id === t.sessionId)?.ref ?? '—'} opened on ${t.environment.machine}`, at: t.createdAt + 1000, tone: 'working' as const });
            if (t.status === 'waiting' && t.wait) rows.push({ id: `${t.id}-w`, text: `waiting · ${t.wait.kind}${t.waitDetail ? ` · Bash ${t.waitDetail}` : ''}`, at: MOCK_NOW - 2 * 60_000, tone: 'needs-you' as const });
            if (t.status === 'completed') rows.push({ id: `${t.id}-c`, text: 'completed · result claimed', at: t.createdAt + 25 * 60_000, tone: 'muted' as const });
            return [t.id, rows];
        })
    );
    for (const t of tree) contracts[t.id] = contractOf(t);
    const approvals: Record<string, { readonly request: OpenRequest; readonly context: ApprovalContext }> = {};
    for (const t of tree) {
        if (t.wait?.kind === 'approval' && t.wait.requestId === PUSH_REQUEST.requestId) approvals[t.id] = { request: PUSH_REQUEST, context: PUSH_CONTEXT };
    }
    const results: TaskView['results'] = Object.fromEntries(
        tree.map((t) => [t.id, t.status === 'completed' ? { verified: true, text: 'Summary delivered to the inbox.' } : { verified: false, text: `No result yet. When ${agentNamed(t.agentId).name} reports one it stays “claimed” until a verification step or you confirm it.` }])
    );
    return { task, root, tree, maxDepth: 3, approvals, contracts, transitions, results, notStopped: root.status === 'cancelled' ? tree.filter((t) => t.status === 'active') : [] };
}

/** `/sessions/:id`. */
export function loadSession(id: string): MockSessionView | undefined {
    return SESSIONS.find((s) => s.id === id);
}

export const sessionsOf = (taskId: TaskId): readonly MockSessionView[] => SESSIONS.filter((s) => s.taskId === taskId);

// ---- addressing (docs/design/HANDOFF.md → Chat) ------------------------------------

export interface Addressing {
    readonly recipients: readonly Recipient[];
    readonly hint: string;
}

/**
 * Who a message activates: mentions ∩ members, else the coordinator, else
 * the single member, else nobody (the composer prints the nobody hint).
 */
export function resolveAddressing(members: readonly MockChatMember[], mentionedIds: readonly string[], lookup: (id: string) => Pick<MockAgentIdentity, 'id' | 'name' | 'hue'> = agentNamed): Addressing {
    const memberIds = new Set(members.map((m) => m.agentId));
    const chip = (agentId: string, role?: string): Recipient => {
        const a = lookup(agentId);
        return { id: a.id, name: a.name, hue: a.hue, role };
    };
    const mentioned = mentionedIds.filter((id) => memberIds.has(id));
    if (mentioned.length) return { recipients: mentioned.map((id) => chip(id)), hint: `${mentioned.map((id) => lookup(id).name).join(', ')} will answer` };
    const coordinator = members.find((m) => m.coordinator);
    if (coordinator) return { recipients: [chip(coordinator.agentId, 'coordinator')], hint: `${lookup(coordinator.agentId).name} answers unless you @ someone` };
    if (members.length === 1) return { recipients: [chip(members[0]!.agentId)], hint: `${lookup(members[0]!.agentId).name} answers` };
    return { recipients: [], hint: '' };
}

/** The `@Name` tokens in a draft, as agent ids (case-insensitive on the name). */
export function mentionedIn(draft: string, members: readonly MockChatMember[]): string[] {
    const names = new Map(members.map((m) => [agentNamed(m.agentId).name.toLowerCase(), m.agentId]));
    const out: string[] = [];
    for (const match of draft.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
        const id = names.get(match[1]!.toLowerCase());
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}
