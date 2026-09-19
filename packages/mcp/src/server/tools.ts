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
import {
    CHAT_FILE_TEXT_MAX_BYTES,
    MODEL_IMAGE_TYPES,
    chatFileUri,
    hasScope,
    isTextLikeMediaType,
    type AgentId,
    type ChatFile,
    type ChatFileStore,
    type ChatId,
    type EnvironmentId,
    type MachineId,
    type MemoryScope,
    type Scope,
    type SessionId,
    type TaskId,
    type WorkspaceId
} from '@agentic/core';
import { defineTool, type AnyTool, type ToolAnnotations } from '@sigx/ai';
import { z } from 'zod';
import { McpScopeError } from './errors.js';
import type { ExternalPrincipal, PlatformPort } from './port.js';

/** What the tool set needs besides the port. */
export interface PlatformToolsOptions {
    /** Where chat attachment bytes live (R2 in the web app). Absent: `chats_file_get` returns metadata only. */
    readonly files?: ChatFileStore;
}

/** An MCP content block a tool hands back as is (the harness only emits JSON text). */
export type ToolContentBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/**
 * The key a tool result carries its own MCP `content` under. The handler
 * lifts it into `result.content` for the tools in `MCP_CONTENT_TOOLS` and
 * leaves the rest of the result as `structuredContent`.
 */
export const MCP_CONTENT_KEY = 'mcpContent';
/** The tools whose results carry `MCP_CONTENT_KEY` — no other tool's result is ever rewritten. */
export const MCP_CONTENT_TOOLS: ReadonlySet<string> = new Set(['chats_file_get']);

/** What `chats_file_get` returns as `structuredContent`; the text or image itself is in `content`. */
export interface ChatFileGetResult {
    readonly file: ChatFile;
    /** The file's `agentic-file:` URI — how chat history references it. */
    readonly uri: string;
    /** `text` and `image`: the content block carries the file; `metadata`: this record is all there is. */
    readonly kind: 'text' | 'image' | 'metadata';
    readonly truncated?: boolean;
    readonly note?: string;
}

export const CHAT_FILE_BYTES_UNAVAILABLE = 'file bytes unavailable on this host';

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Base64 without `node:` APIs (edge-safe), in chunks so a large image does not blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** The first `max` bytes of UTF-8 as a string, cut on a character boundary. */
function utf8Prefix(bytes: Uint8Array, max: number): { readonly text: string; readonly truncated: boolean } {
    if (bytes.length <= max) return { text: new TextDecoder().decode(bytes), truncated: false };
    let end = max;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

const isModelImage = (mediaType: string): boolean => MODEL_IMAGE_TYPES.includes(mediaType.split(';')[0]!.trim().toLowerCase());

/**
 * `chats_file_get`: the chat decides (`Chat.fileAccess` as this client), the
 * store only holds bytes. Missing and not visible are the same answer, so a
 * client cannot probe for files it may not read.
 */
async function getChatFile(port: PlatformPort, files: ChatFileStore | undefined, workspaceId: WorkspaceId, chatId: ChatId, fileId: string): Promise<ChatFileGetResult & { readonly [MCP_CONTENT_KEY]: readonly ToolContentBlock[] }> {
    if (!port.chats.fileAccess) throw new Error(`chats_file_get: chat files are not available on this host`);
    const file = await port.chats.fileAccess(chatId, fileId);
    if (!file) throw new Error(`not found: file "${fileId}" does not exist in chat "${chatId}" or this client may not read it`);
    const uri = chatFileUri(chatId, fileId);
    const reply = (result: ChatFileGetResult, blocks: readonly ToolContentBlock[] = []) => ({ ...result, [MCP_CONTENT_KEY]: [{ type: 'text' as const, text: JSON.stringify(result) }, ...blocks] });
    const text = isTextLikeMediaType(file.mediaType);
    const image = !text && isModelImage(file.mediaType);
    if (!text && !image) return reply({ file, uri, kind: 'metadata', note: `binary file (${file.mediaType}, ${kb(file.bytes)}): only its metadata is returned` });
    if (!files) return reply({ file, uri, kind: 'metadata', note: CHAT_FILE_BYTES_UNAVAILABLE });
    const body = await files.get(workspaceId, chatId, fileId);
    if (!body) return reply({ file, uri, kind: 'metadata', note: 'file bytes are missing from the store' });
    if (image) return reply({ file, uri, kind: 'image' }, [{ type: 'image', data: toBase64(body.bytes), mimeType: file.mediaType }]);
    const { text: content, truncated } = utf8Prefix(body.bytes, CHAT_FILE_TEXT_MAX_BYTES);
    const result: ChatFileGetResult = truncated ? { file, uri, kind: 'text', truncated: true, note: `truncated: the first ${kb(CHAT_FILE_TEXT_MAX_BYTES)} of ${kb(file.bytes)}` } : { file, uri, kind: 'text' };
    return reply(result, [{ type: 'text', text: content }]);
}

/** What the surface declares but does not do yet — enumerated, never implied (PLG-09). */
export const PLATFORM_MCP_UNSUPPORTED: readonly { readonly op: string; readonly reason: string }[] = [
    { op: 'resources', reason: 'sessions_tail is the only read stream; MCP resources and prompts are out of scope for the orchestration surface' },
    { op: 'prompts', reason: 'no prompt templates; the instructions string is the only guidance the server offers' }
];

const READ: ToolAnnotations = { readOnly: true, idempotent: true };
const WRITE: ToolAnnotations = { readOnly: false, destructive: false };
const DESTRUCTIVE: ToolAnnotations = { readOnly: false, destructive: true };

const TAIL_DEFAULT = 100;
const TAIL_MAX = 500;
const HISTORY_MAX = 200;

const id = (what: string) => z.string().min(1).describe(what);
/** A url-safe id segment, as `agentic-file:<chatId>/<fileId>` requires. */
const segment = (what: string) => z.string().regex(/^[A-Za-z0-9_-]+$/, 'expected a url-safe id').describe(what);
const cursor = z.object({ epoch: z.number().int().min(0), seq: z.number().int().min(0) }).describe('An event cursor from a previous sessions_tail `next`.');

const memoryScope = z
    .string()
    .regex(/^(agent:.+|shared:.+)$/, 'scope must be agent:<agentId> or shared:<name>')
    .describe('The memory scope: `agent:<agentId>` (an agent’s private memory) or `shared:<name>`.');

const memoryKind = z.enum(['working', 'fact', 'preference', 'assumption', 'lesson', 'record']);

/** Every tool of the surface, gated by the principal's scopes. */
export function platformTools(port: PlatformPort, principal: ExternalPrincipal, options: PlatformToolsOptions = {}): AnyTool[] {
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
        tool({
            name: 'usage_limits',
            scope: 'usage',
            description:
                'How close each account (a machine’s environment) is to its provider’s usage limits, e.g. Claude Code’s current session and current week: per window `utilization` (0..1), `status` (ok | warning | exhausted | unknown) and `resetsAt` (ISO). ' +
                'Use it to choose an environment with headroom before sessions_open. Weigh each window’s `resetsAt` (an exhausted window that resets soon may be fine for later work) and the snapshot’s `ageMs` (an old snapshot, or one from an offline machine, may no longer be true). ' +
                '`snapshot: null` means nothing reported yet; `availability: "not-reported"` comes with a `reason`. Informational only: nothing is switched for you.',
            input: z.object({ machineId: id('Limit to this machine.').optional(), runtime: z.string().min(1).optional().describe('Limit to one runtime, e.g. claude-code.') }),
            annotations: READ,
            run: (input) => port.usage.limits({ ...(input.machineId ? { machineId: input.machineId as MachineId } : {}), ...(input.runtime ? { runtime: input.runtime } : {}) })
        }),
        tool({
            name: 'environments_doctor',
            scope: 'environments',
            description: 'The daemon’s doctor verdicts (isolation, account auth — EXE-05/07) for one machine’s environments, as last reported; `unverified` lists environments the daemon sent no verdict for.',
            input: z.object({ machineId: id('The machine to inspect.'), environmentId: z.string().min(1).optional().describe('One environment only.') }),
            annotations: READ,
            run: (input) => port.environments.doctor(input.machineId as MachineId, input.environmentId as EnvironmentId | undefined)
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
                cwd: z.string().min(1).optional().describe('The folder the session runs in: absolute, inside one of the environment’s cwd roots (checked by the machine’s path rules). Default: the first root.'),
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
            description:
                'Delegate a sub-task from an active task to another agent (COL-03): the child is created under the parent’s limits, the parent waits on it, and the router places the child on its own runtime and environment. Returns the child task; follow it with tasks_get / tasks_tree. `callId` makes the call idempotent.',
            input: z.object({
                taskId: id('The parent task (active).'),
                agentId: id('The assignee.'),
                objective: z.string().min(1).describe('What the child must achieve.'),
                context: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
                constraints: z.object({ maxTurns: z.number().int().positive().optional(), maxCostUsd: z.number().positive().optional(), maxWallMs: z.number().int().positive().optional() }).optional(),
                environmentId: z.string().min(1).optional().describe('The child’s environment; explicit beats the assignee’s default.'),
                callId: z.string().min(1).optional().describe('Idempotency key: the same id re-finds the same child.')
            }),
            annotations: WRITE,
            run: (input) =>
                port.tasks.delegate({
                    taskId: input.taskId as TaskId,
                    agentId: input.agentId as AgentId,
                    objective: input.objective,
                    ...(input.context !== undefined ? { context: input.context } : {}),
                    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
                    ...(input.environmentId !== undefined ? { environmentId: input.environmentId as EnvironmentId } : {}),
                    ...(input.callId !== undefined ? { callId: input.callId } : {})
                })
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
            description: `A page of a chat’s history, newest page first; pass \`cursor\` from \`next\` for older entries (max ${HISTORY_MAX} per page). Attachments are \`image\` / \`file\` parts whose \`url\` is an \`agentic-file:<chatId>/<fileId>\` URI — fetch one with chats_file_get.`,
            input: z.object({ chatId: id('The chat id.'), cursor: z.number().int().min(0).nullable().optional(), limit: z.number().int().min(1).max(HISTORY_MAX).optional() }),
            annotations: READ,
            run: (input) => port.chats.history(input.chatId as ChatId, input.cursor ?? null, input.limit ?? 50)
        }),
        tool({
            name: 'chats_file_get',
            scope: 'chats',
            description: `A file attached to a chat, as referenced by an \`agentic-file:<chatId>/<fileId>\` URI in chats_history. The first content block is always a JSON summary (file record, uri, kind, truncated?, note?); a second block follows with the text of a text file (cut at ${kb(CHAT_FILE_TEXT_MAX_BYTES)}) or an image block for a ${MODEL_IMAGE_TYPES.join(' / ')} image. Anything else is the summary alone.`,
            input: z.object({ chatId: segment('The chat id.'), fileId: segment('The file id — the part after the chat id in the URI.') }),
            annotations: READ,
            run: (input) => getChatFile(port, options.files, principal.workspaceId, input.chatId as ChatId, input.fileId)
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
    return family === 'machines' || family === 'environments' || family === 'agents' || family === 'sessions' || family === 'tasks' || family === 'chats' || family === 'memory' || family === 'schedules' || family === 'usage' ? family : null;
}
