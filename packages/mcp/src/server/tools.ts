/**
 * The orchestration tool families (architecture §9) as `@sigx/ai`
 * `defineTool`s over a `PlatformPort`, bound to one external principal.
 *
 * Names: MCP allows `machines.list`, provider tool names do not (`defineTool`
 * accepts `[A-Za-z0-9_-]` only), so the wire name is `machines_list` —
 * `<family>_<op>`. The family is the scope that gates it (`hasScope`); a
 * call without it throws `McpScopeError`, which the handler reports as an
 * `isError` tool result. Every tool carries `readOnly` / `destructive`
 * annotations so a client's `allowReadOnly`-style policy can decide without
 * knowing the tool.
 *
 * Machine selection is explicit in every call that opens execution
 * (`sessions_open` needs `machineId` AND `environmentId`, EXE-12); nothing
 * here ever picks a machine on the client's behalf.
 */
import { hasScope, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MemoryScope, type Scope, type SessionId, type TaskId } from '@agentic/core';
import { defineTool, type AnyTool, type ToolAnnotations } from '@sigx/ai';
import { z } from 'zod';
import { McpScopeError, McpUnsupportedError } from './errors.js';
import type { ExternalPrincipal, PlatformPort } from './port.js';

/** What the surface declares but does not do yet — enumerated, never implied (PLG-09). */
export const PLATFORM_MCP_UNSUPPORTED: readonly { readonly op: string; readonly reason: string }[] = [
    { op: 'tasks.delegate', reason: 'delegation semantics land with #39; the tool is declared and answers unsupported until then' },
    { op: 'environments.doctor', reason: 'the daemon doctor is not exposed on the Machine actor yet (#43); omitted rather than stubbed' },
    { op: 'resources', reason: 'sessions_tail is the only read stream; MCP resources and prompts are out of scope for the orchestration surface' }
];

const READ: ToolAnnotations = { readOnly: true, idempotent: true };
const WRITE: ToolAnnotations = { readOnly: false, destructive: false };
const DESTRUCTIVE: ToolAnnotations = { readOnly: false, destructive: true };

const TAIL_DEFAULT = 100;
const TAIL_MAX = 500;
const HISTORY_MAX = 200;

const id = (what: string) => z.string().min(1).describe(what);
const cursor = z.object({ epoch: z.number().int().min(0), seq: z.number().int().min(0) }).describe('An event cursor from a previous sessions_tail `next`.');

const memoryScope = z
    .string()
    .regex(/^(agent:.+|shared:.+)$/, 'scope must be agent:<agentId> or shared:<name>')
    .describe('The memory scope: `agent:<agentId>` (an agent’s private memory) or `shared:<name>`.');

const memoryKind = z.enum(['working', 'fact', 'preference', 'assumption', 'lesson', 'record']);

/** Every tool of the surface, gated by the principal's scopes. */
export function platformTools(port: PlatformPort, principal: ExternalPrincipal): AnyTool[] {
    const gate = (tool: string, scope: Scope): void => {
        if (!hasScope(principal, scope)) throw new McpScopeError(tool, scope);
    };
    const tool = <S extends z.ZodType<Record<string, unknown>>, O>(spec: { name: string; scope: Scope; description: string; input: S; annotations: ToolAnnotations; run: (input: z.output<S>) => Promise<O> }): AnyTool =>
        defineTool({
            name: spec.name,
            description: spec.description,
            input: spec.input,
            annotations: spec.annotations,
            execute: (input) => {
                gate(spec.name, spec.scope);
                return spec.run(input as z.output<S>);
            }
        });

    return [
        // ---- machines / environments ------------------------------------------------
        tool({
            name: 'machines_list',
            scope: 'machines',
            description: 'List the workspace’s paired machines: online state, daemon version and the environments each one reports. Pick a machine explicitly before opening a session.',
            input: z.object({}),
            annotations: READ,
            run: () => port.machines.list()
        }),
        tool({
            name: 'environments_list',
            scope: 'environments',
            description: 'List execution environments (runtime, account, cwd roots, concurrency) across all machines, or on one machine.',
            input: z.object({ machineId: id('Limit to this machine.').optional() }),
            annotations: READ,
            run: (input) => port.environments.list(input.machineId as MachineId | undefined)
        }),

        // ---- agents --------------------------------------------------------------------
        tool({
            name: 'agents_list',
            scope: 'agents',
            description: 'List the workspace’s agents with their runtime and default environment.',
            input: z.object({}),
            annotations: READ,
            run: () => port.agents.list()
        }),
        tool({
            name: 'agents_get',
            scope: 'agents',
            description: 'The full configuration of one agent (instructions, execution defaults, tools, limits, versions).',
            input: z.object({ agentId: id('The agent id.') }),
            annotations: READ,
            run: (input) => port.agents.get(input.agentId as AgentId)
        }),

        // ---- sessions ------------------------------------------------------------------
        tool({
            name: 'sessions_open',
            scope: 'sessions',
            description:
                'Open a session for an agent on an explicitly chosen machine and environment: creates a task and hands it to the router, which never switches environment afterwards (EXE-12). Returns the task; its `sessionId` appears once the machine accepted it — poll tasks_get or sessions_tail.',
            input: z.object({
                agentId: id('The agent to run.'),
                machineId: id('The machine that must host the session (from machines_list).'),
                environmentId: id('An environment that machine reports (from environments_list).'),
                cwd: z.string().min(1).optional().describe('Working directory inside one of the environment’s cwd roots.'),
                objective: z.string().min(1).optional().describe('What the session is for; becomes the task objective and the first prompt.')
            }),
            annotations: WRITE,
            run: (input) =>
                port.sessions.open({
                    agentId: input.agentId as AgentId,
                    machineId: input.machineId as MachineId,
                    environmentId: input.environmentId as EnvironmentId,
                    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                    ...(input.objective !== undefined ? { objective: input.objective } : {})
                })
        }),
        tool({
            name: 'sessions_prompt',
            scope: 'sessions',
            description: 'Send a prompt to an open session (one turn). Returns the turn id; follow the turn with sessions_tail.',
            input: z.object({ sessionId: id('The session id.'), text: z.string().min(1).describe('The prompt, in markdown.') }),
            annotations: WRITE,
            run: (input) => port.sessions.prompt(input.sessionId as SessionId, input.text)
        }),
        tool({
            name: 'sessions_respond',
            scope: 'sessions',
            description: 'Answer a session’s open request: a permission decision (allow/deny, once or for the session) or the answers to an input request.',
            input: z.object({
                sessionId: id('The session id.'),
                requestId: id('The request id from the `request` event.'),
                decision: z.union([
                    z.object({ type: z.literal('permission'), outcome: z.enum(['allow', 'deny']), scope: z.enum(['once', 'session']).optional(), message: z.string().optional() }),
                    z.object({ type: z.literal('input'), answers: z.unknown() })
                ])
            }),
            annotations: WRITE,
            run: (input) => port.sessions.respond(input.sessionId as SessionId, input.requestId, input.decision)
        }),
        tool({
            name: 'sessions_cancel',
            scope: 'sessions',
            description: 'Cancel the running turn of a session. The session stays open for another prompt.',
            input: z.object({ sessionId: id('The session id.') }),
            annotations: DESTRUCTIVE,
            run: (input) => port.sessions.cancel(input.sessionId as SessionId)
        }),
        tool({
            name: 'sessions_tail',
            scope: 'sessions',
            description: `A bounded page of a session’s events after a cursor (omit \`from\` for the start). Returns \`next\` to continue and \`truncated\` when more than \`limit\` (default ${TAIL_DEFAULT}, max ${TAIL_MAX}) were available.`,
            input: z.object({ sessionId: id('The session id.'), from: cursor.optional(), limit: z.number().int().min(1).max(TAIL_MAX).optional() }),
            annotations: READ,
            run: (input) => port.sessions.tail(input.sessionId as SessionId, input.from, input.limit ?? TAIL_DEFAULT)
        }),

        // ---- tasks ----------------------------------------------------------------------
        tool({
            name: 'tasks_create',
            scope: 'tasks',
            description: 'Create a task for an agent and hand it to the router. `environmentId` is optional (the agent’s default is used) and, once chosen, never switched (EXE-12).',
            input: z.object({
                agentId: id('The assignee.'),
                objective: z.string().min(1).describe('What must be achieved.'),
                environmentId: z.string().min(1).optional().describe('The environment to run in; explicit beats the agent default.'),
                context: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional().describe('Context parts handed to the agent with the objective.'),
                constraints: z.object({ maxTurns: z.number().int().positive().optional(), maxCostUsd: z.number().positive().optional(), maxWallMs: z.number().int().positive().optional() }).optional()
            }),
            annotations: WRITE,
            run: (input) =>
                port.tasks.create({
                    agentId: input.agentId as AgentId,
                    objective: input.objective,
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId as EnvironmentId } : {}),
                    ...(input.context !== undefined ? { context: input.context } : {}),
                    ...(input.constraints !== undefined ? { constraints: input.constraints } : {})
                })
        }),
        tool({
            name: 'tasks_delegate',
            scope: 'tasks',
            description: 'Delegate a sub-task from an existing task to another agent (COL-03). Declared; unsupported until #39 lands.',
            input: z.object({ taskId: id('The parent task.'), agentId: id('The assignee.'), objective: z.string().min(1) }),
            annotations: WRITE,
            run: () => Promise.reject(new McpUnsupportedError('tasks_delegate', PLATFORM_MCP_UNSUPPORTED[0]!.reason))
        }),
        tool({
            name: 'tasks_get',
            scope: 'tasks',
            description: 'One task: status, why it waits, its session, result or error.',
            input: z.object({ taskId: id('The task id.') }),
            annotations: READ,
            run: (input) => port.tasks.get(input.taskId as TaskId)
        }),
        tool({
            name: 'tasks_tree',
            scope: 'tasks',
            description: 'A task and every descendant (the delegation tree, COL-09).',
            input: z.object({ taskId: id('The root task id.') }),
            annotations: READ,
            run: (input) => port.tasks.tree(input.taskId as TaskId)
        }),
        tool({
            name: 'tasks_cancel',
            scope: 'tasks',
            description: 'Cancel a task and its subtree; reports what could not be confirmed stopped (COL-12).',
            input: z.object({ taskId: id('The task id.') }),
            annotations: DESTRUCTIVE,
            run: (input) => port.tasks.cancel(input.taskId as TaskId)
        }),

        // ---- chats ----------------------------------------------------------------------
        tool({
            name: 'chats_post',
            scope: 'chats',
            description: 'Post a message into a chat as the workspace user, optionally addressing agents (`mentions`, or "all").',
            input: z.object({
                chatId: id('The chat id.'),
                text: z.string().min(1).describe('The message, in markdown.'),
                mentions: z.union([z.array(z.string().min(1)), z.literal('all')]).optional()
            }),
            annotations: WRITE,
            run: (input) => port.chats.post({ chatId: input.chatId as ChatId, text: input.text, ...(input.mentions !== undefined ? { mentions: input.mentions as readonly AgentId[] | 'all' } : {}) })
        }),
        tool({
            name: 'chats_history',
            scope: 'chats',
            description: `A page of a chat’s history, newest page first; pass \`cursor\` from \`next\` for older entries (max ${HISTORY_MAX} per page).`,
            input: z.object({ chatId: id('The chat id.'), cursor: z.number().int().min(0).nullable().optional(), limit: z.number().int().min(1).max(HISTORY_MAX).optional() }),
            annotations: READ,
            run: (input) => port.chats.history(input.chatId as ChatId, input.cursor ?? null, input.limit ?? 50)
        }),

        // ---- memory ---------------------------------------------------------------------
        tool({
            name: 'memory_search',
            scope: 'memory',
            description: 'Search a memory scope (text, tags, kinds), ranked.',
            input: z.object({
                scope: memoryScope,
                text: z.string().optional(),
                tags: z.array(z.string()).optional(),
                kinds: z.array(memoryKind).optional(),
                subject: z.string().optional(),
                limit: z.number().int().min(1).max(100).optional(),
                since: z.number().int().optional()
            }),
            annotations: READ,
            run: (input) =>
                port.memory.search(input.scope as MemoryScope, {
                    limit: input.limit ?? 20,
                    ...(input.text !== undefined ? { text: input.text } : {}),
                    ...(input.tags !== undefined ? { tags: input.tags } : {}),
                    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
                    ...(input.subject !== undefined ? { subject: input.subject } : {}),
                    ...(input.since !== undefined ? { since: input.since } : {})
                })
        }),
        tool({
            name: 'memory_remember',
            scope: 'memory',
            description: 'Add an entry to a memory scope. Provenance is recorded as the user (the external client acts in their name).',
            input: z.object({
                scope: memoryScope,
                kind: memoryKind,
                text: z.string().min(1),
                tags: z.array(z.string()).optional(),
                subject: z.string().optional(),
                confidence: z.enum(['verified', 'stated', 'assumed']).optional(),
                conditions: z.string().optional()
            }),
            annotations: WRITE,
            run: (input) =>
                port.memory.remember(input.scope as MemoryScope, {
                    kind: input.kind,
                    text: input.text,
                    tags: input.tags ?? [],
                    confidence: input.confidence ?? 'stated',
                    provenance: { source: 'user' },
                    ...(input.subject !== undefined ? { subject: input.subject } : {}),
                    ...(input.conditions !== undefined ? { conditions: input.conditions } : {})
                })
        }),

        // ---- schedules ------------------------------------------------------------------
        tool({
            name: 'schedules_create',
            scope: 'schedules',
            description: 'Create a schedule: a one-off reminder (`at`, epoch ms) or a cron recurrence with an IANA time zone; with an agent it creates a task on each firing under the offline policy.',
            input: z.object({
                title: z.string().min(1),
                kind: z.enum(['reminder', 'recurring', 'agent-task']),
                recurrence: z.union([z.object({ kind: z.literal('at'), at: z.number().int() }), z.object({ kind: z.literal('cron'), cron: z.string().min(1), tz: z.string().min(1) })]),
                agentId: z.string().min(1).optional(),
                environmentId: z.string().min(1).optional(),
                prompt: z.string().optional(),
                offlinePolicy: z.enum(['queue', 'fail', 'fallback-api']).optional()
            }),
            annotations: WRITE,
            run: (input) =>
                port.schedules.create({
                    title: input.title,
                    kind: input.kind,
                    recurrence: input.recurrence,
                    ...(input.agentId !== undefined ? { agentId: input.agentId as AgentId } : {}),
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId as EnvironmentId } : {}),
                    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                    ...(input.offlinePolicy !== undefined ? { offlinePolicy: input.offlinePolicy } : {})
                })
        })
    ];
}

/** The scope a tool name belongs to — `<family>_<op>`. */
export function scopeOfTool(name: string): Scope | null {
    const family = name.split('_')[0];
    return family === 'machines' || family === 'environments' || family === 'agents' || family === 'sessions' || family === 'tasks' || family === 'chats' || family === 'memory' || family === 'schedules' ? family : null;
}
