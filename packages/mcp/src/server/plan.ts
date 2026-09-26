/**
 * The `plan` tool family on the orchestration surface (#751; PRJ-12): the eight `plan_*` tools for an external client,
 * over an injected `PlanMcpPort` (the app binds it to the Plan actor under the client's principal). An external client
 * acts in its user's name, so it has the people's tools too (`plan_assign`, `plan_add`); the Plan actor enforces every
 * rule — claims, leases, limits, `after` — and its refusals come back as `isError` results. The family is gated by the
 * `projects` scope: a plan is a project feature.
 */
import { PLAN_TOOLS, formatRef, parseRef, type AgentId, type Plan, type PlanItem, type PlanItemState, type ProjectId, type Ref, type Scope } from '@agentic/core';
import type { AnyTool, ToolAnnotations } from '@sigx/ai';
import { z } from 'zod';

/** What the surface hands the Plan actor on `plan_update`. */
export interface PlanMcpUpdate {
    readonly check?: readonly number[];
    readonly uncheck?: readonly number[];
    readonly note?: string;
    readonly state?: Exclude<PlanItemState, 'claimed'>;
}

export interface PlanMcpAdd {
    readonly plan?: string;
    readonly phase?: number;
    /** `after`: this project's item numbers, or `project#n` for an item in another project. */
    readonly items: readonly { readonly title: string; readonly after?: readonly (number | string)[]; readonly touches?: readonly string[]; readonly doneWhen?: readonly string[] }[];
    readonly split?: number;
}

/** The Plan actor as the surface calls it, one per authenticated client; members are named by handle (`lint`). */
export interface PlanMcpPort {
    list(projectId: ProjectId, planId?: string): Promise<readonly Plan[]>;
    /** What `agentId` should work on next: its queue, then open items; `null` when nothing is ready. */
    next(projectId: ProjectId, agentId: AgentId, planId?: string): Promise<PlanItem | null>;
    /** `leaseMs` `undefined` (none asked) takes the project's lease. */
    claim(projectId: ProjectId, item: number, agentId: AgentId, leaseMs: number | undefined): Promise<PlanItem>;
    assign(projectId: ProjectId, item: number, to: string, index?: number): Promise<PlanItem>;
    update(projectId: ProjectId, item: number, update: PlanMcpUpdate): Promise<PlanItem>;
    /**
     * Replace everything `item` waits on (#931): item numbers of this project, or `project#n` for another project's.
     * Optional: a host without it refuses `plan_update` with `after`.
     */
    after?(projectId: ProjectId, item: number, after: readonly (number | string)[]): Promise<PlanItem>;
    /** A file ref comes back pinned to a commit. */
    ref(projectId: ProjectId, item: number, ref: Ref): Promise<Ref>;
    add(projectId: ProjectId, input: PlanMcpAdd): Promise<readonly PlanItem[]>;
    handoff(projectId: ProjectId, item: number, to: string | undefined, note: string): Promise<PlanItem>;
}

/** The surface's scoped tool factory (`platformTools`' `tool`). */
export type ScopedTool = <S extends z.ZodType<Record<string, unknown>>, O>(spec: { name: string; scope: Scope; description: string; input: S; annotations: ToolAnnotations; run: (input: z.output<S>) => Promise<O> }) => AnyTool;

/** The scope the plan family is gated by. */
export const PLAN_SCOPE: Scope = 'projects';

const READ: ToolAnnotations = { readOnly: true, idempotent: true };
const WRITE: ToolAnnotations = { readOnly: false, destructive: false };

const projectId = z.string().min(1).describe('The project whose plan this is (projects_list).');
const itemNo = z.number().int().min(1).describe('The item number, `#n` without the `#`.');
const planId = z.string().min(1).optional().describe('One plan by id; absent: every plan of the project.');
const handle = z.string().min(1).describe('A project member by handle, `lint` or `@lint`.');
const bare = (h: string): string => h.replace(/^@/, '');
/** One `after` entry: an item number of this project, or `project#n` for an item in another project (#881). */
const afterEntry = z.union([z.number().int().min(1), z.string().regex(/^[\w.-]*#[1-9]\d*$/, 'write an item number, #n or project#n')]).describe('An item number of this project (`9`), or `project#n` for an item in another project — it stays blocked until that item is done.');

/**
 * The plan tools (`PLAN_TOOLS` order) over `port`, made with the surface's gated `tool` factory. A host without a Plan
 * port declares none of them, so a client never sees a tool that cannot work.
 */
export function planMcpTools(port: PlanMcpPort | undefined, tool: ScopedTool): AnyTool[] {
    if (!port) return [];
    const [LIST, NEXT, CLAIM, ASSIGN, UPDATE, REF, ADD, HANDOFF] = PLAN_TOOLS;
    return [
        tool({
            name: LIST,
            scope: PLAN_SCOPE,
            description: 'A project’s plans: phases and items with state, owner, queue, claim and lease, after, touches, refs and done-when.',
            input: z.object({ projectId, plan: planId }),
            annotations: READ,
            run: async (input) => ({ plans: await port.list(input.projectId as ProjectId, input.plan) })
        }),
        tool({
            name: NEXT,
            scope: PLAN_SCOPE,
            description: 'The item an agent should work on next: its own queue first, then open items whose after-items are done and whose paths clash with no work in progress.',
            input: z.object({ projectId, agentId: z.string().min(1).describe('The agent to pick for.'), plan: planId }),
            annotations: READ,
            run: async (input) => ({ item: await port.next(input.projectId as ProjectId, input.agentId as AgentId, input.plan) })
        }),
        tool({
            name: CLAIM,
            scope: PLAN_SCOPE,
            description: 'Start an item for an agent with a lease (default: the project’s lease, 30 minutes unless set; any plan_* call renews it). Refused while it waits on unfinished items, is taken, or the agent holds its limit.',
            input: z.object({ projectId, item: itemNo, agentId: z.string().min(1).describe('The agent that starts it.'), leaseMinutes: z.number().int().min(1).max(240).optional() }),
            annotations: WRITE,
            run: (input) => port.claim(input.projectId as ProjectId, input.item, input.agentId as AgentId, input.leaseMinutes !== undefined ? input.leaseMinutes * 60_000 : undefined)
        }),
        tool({
            name: ASSIGN,
            scope: PLAN_SCOPE,
            description: 'Put an item in a member’s queue, at `index` (0 first) or at the end.',
            input: z.object({ projectId, item: itemNo, to: handle, index: z.number().int().min(0).optional() }),
            annotations: WRITE,
            run: (input) => port.assign(input.projectId as ProjectId, input.item, bare(input.to), input.index)
        }),
        tool({
            name: UPDATE,
            scope: PLAN_SCOPE,
            description: 'Tick or untick done-when lines (0-based), add a History note, change an item’s state (a person may mark it done), or replace what it waits on with `after` — `project#n` names another project’s item.',
            input: z.object({
                projectId,
                item: itemNo,
                check: z.array(z.number().int().min(0)).optional(),
                uncheck: z.array(z.number().int().min(0)).optional(),
                note: z.string().min(1).optional(),
                state: z.enum(['ready', 'needs-you', 'blocked', 'done', 'stuck']).optional(),
                after: z.array(afterEntry).max(50).optional().describe('Replace what the item waits on; `[]` clears it. List what it already waits on to keep it.')
            }),
            annotations: WRITE,
            run: async (input) => {
                const patching = !!input.check?.length || !!input.uncheck?.length || input.note !== undefined || input.state !== undefined;
                if (!patching && input.after === undefined) throw new Error(`${UPDATE}: nothing to change on #${input.item}: pass check, uncheck, note, state or after`);
                if (input.after !== undefined) {
                    if (!port.after) throw new Error(`${UPDATE}: changing what an item waits on is not available on this host`);
                    const linked = await port.after(input.projectId as ProjectId, input.item, input.after);
                    if (!patching) return linked;
                }
                return port.update(input.projectId as ProjectId, input.item, {
                    ...(input.check ? { check: input.check } : {}),
                    ...(input.uncheck ? { uncheck: input.uncheck } : {}),
                    ...(input.note !== undefined ? { note: input.note } : {}),
                    ...(input.state !== undefined ? { state: input.state } : {})
                });
            }
        }),
        tool({
            name: REF,
            scope: PLAN_SCOPE,
            description: 'Attach one ref to an item: `#9`, `signalx#14`, `@lint`, `path/file.ts:38-41` (pinned to the current commit), `pr:604`, `4f2a9c1`, `chat:msg-42`, `doc:architecture.md#7` or a URL.',
            input: z.object({ projectId, item: itemNo, ref: z.string().min(1) }),
            annotations: WRITE,
            run: async (input) => {
                const ref = parseRef(input.ref);
                if (!ref) throw new Error(`${REF}: "${input.ref}" is not one ref — write #9, signalx#14, @lint, path/file.ts:38-41, pr:604, 4f2a9c1, chat:msg-42, doc:architecture.md#7 or a URL`);
                const attached = await port.ref(input.projectId as ProjectId, input.item, ref);
                return { item: input.item, ref: formatRef(attached) };
            }
        }),
        tool({
            name: ADD,
            scope: PLAN_SCOPE,
            description: 'Add items to a plan phase, or split an item into several (`split`).',
            input: z.object({
                projectId,
                plan: planId,
                phase: z.number().int().min(1).optional(),
                items: z.array(z.object({ title: z.string().min(1), after: z.array(afterEntry).optional(), touches: z.array(z.string().min(1)).optional(), doneWhen: z.array(z.string().min(1)).optional() })).min(1),
                split: z.number().int().min(1).optional()
            }),
            annotations: WRITE,
            run: async (input) => {
                const { projectId: project, ...rest } = input;
                const items = await port.add(project as ProjectId, {
                    items: rest.items,
                    ...(rest.plan !== undefined ? { plan: rest.plan } : {}),
                    ...(rest.phase !== undefined ? { phase: rest.phase } : {}),
                    ...(rest.split !== undefined ? { split: rest.split } : {})
                });
                return { added: items.map((i) => ({ id: i.id, title: i.title })) };
            }
        }),
        tool({
            name: HANDOFF,
            scope: PLAN_SCOPE,
            description: 'Release an item with a note, to a member (`to`) or back to whoever assigned it.',
            input: z.object({ projectId, item: itemNo, to: handle.optional(), note: z.string().min(1) }),
            annotations: WRITE,
            run: (input) => port.handoff(input.projectId as ProjectId, input.item, input.to !== undefined ? bare(input.to) : undefined, input.note)
        })
    ];
}
