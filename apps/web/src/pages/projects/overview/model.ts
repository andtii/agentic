/**
 * The project Overview's view model (#730, HANDOFF.md → "Project home"): what the header, the Your move and Chats
 * columns and the rail's fixed cards draw, from the `ProjectRecord` and the page's data. Pure: the mock page and the
 * live page render the same view over it.
 */
import { parseProjectFolderKey, type ProjectRecord } from '@agentic/core';
import type { AgentHue, IconName } from '@agentic/ui';

/** A row of **Your move**: something in the project waiting on the person (from work items once K1 lands). */
export interface OverviewMove {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    /** The item, chat or PR the row opens. */
    readonly href: string;
    /** The mono ref tag at the right: `#602`, `chat`, `gmail draft`. */
    readonly ref: string;
    readonly refIcon?: IconName;
    readonly at: number;
}

export type OverviewChatState = 'needs-you' | 'working' | 'idle';

/** One of the project's recent chats. */
export interface OverviewChat {
    readonly id: string;
    readonly title: string;
    readonly state: OverviewChatState;
    /** Who wrote the last line (`You` for the person), when the line has a speaker, and the line itself. */
    readonly lastBy?: string;
    readonly lastLine: string;
    /** Agent ids on the chat, in roster order; the person's tile always comes first. */
    readonly members: readonly string[];
    /** The linked work: tasks, PRs, dates, items. */
    readonly links: readonly { readonly label: string; readonly icon?: IconName }[];
    readonly at: number;
}

export interface OverviewSchedule {
    readonly id: string;
    readonly title: string;
    /** The agent that runs it; absent for a plain reminder. */
    readonly agentId?: string;
    /** The next run as the schedules page words it (`tonight 02:00`). */
    readonly next: string;
}

/** What the page shows besides the record. */
export interface OverviewData {
    readonly moves: readonly OverviewMove[];
    /** Most recent first; the page shows the first five. */
    readonly chats: readonly OverviewChat[];
    readonly schedules: readonly OverviewSchedule[];
}

export const EMPTY_OVERVIEW: OverviewData = { moves: [], chats: [], schedules: [] };

/** Which of the Overview's live cards are still waiting for their first read: those draw skeleton rows, never the empty line. */
export interface OverviewLoading {
    readonly moves?: boolean;
    readonly chats?: boolean;
    readonly schedules?: boolean;
}

/** The Chats card shows this many. */
export const RECENT_CHATS = 5;

/** The name and hue an agent id resolves to. */
export type AgentNames = (id: string) => { readonly name: string; readonly hue?: AgentHue };

/** A feature's header tag: the last segment of a plugin id (`agentic.feature.git` → `git`). */
export function featureTagOf(featureId: string): string {
    const parts = featureId.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? featureId;
}

/** A connector's tag: its id with the dashes as spaces (`github-mcp` → `github mcp`). */
export const connectorTagOf = (connectorId: string): string => connectorId.replace(/[-_]+/g, ' ');

/** The header's tags: one per enabled feature, then one per connector. */
export function projectTagsOf(project: Pick<ProjectRecord, 'features' | 'connectors'>): { readonly kind: 'feature' | 'connector'; readonly id: string; readonly label: string }[] {
    return [
        ...Object.keys(project.features).map((id) => ({ kind: 'feature' as const, id, label: featureTagOf(id) })),
        ...project.connectors.map((c) => ({ kind: 'connector' as const, id: c.id, label: connectorTagOf(c.id) }))
    ];
}

/** Where the project's folders are, one entry per machine (a machine's own folder before its overrides), in record order. */
export function folderPlacesOf(project: Pick<ProjectRecord, 'folders'>): { readonly machine: string; readonly path: string }[] {
    const byMachine = new Map<string, { path: string; shared: boolean }>();
    for (const [key, path] of Object.entries(project.folders)) {
        const parsed = typeof path === 'string' && path ? parseProjectFolderKey(key) : null;
        if (!parsed) continue;
        // A pre-#702 key names only an environment: shown under that id.
        const machine = parsed.machineId ?? parsed.environmentId!;
        const shared = parsed.machineId !== undefined && parsed.environmentId === undefined;
        const had = byMachine.get(machine);
        if (!had || (shared && !had.shared)) byMachine.set(machine, { path: path!, shared });
    }
    return [...byMachine].map(([machine, { path }]) => ({ machine, path }));
}

/** The header's folder line: `machine → path` for the first folder, or the no-folder line. */
export function folderLineOf(project: Pick<ProjectRecord, 'folders'>): string {
    const first = folderPlacesOf(project)[0];
    return first ? `${first.machine} → ${first.path}` : 'no folder · runs on the platform';
}

/** The People and places card's rows. */
export function peopleOf(project: Pick<ProjectRecord, 'members' | 'folders' | 'connectors'>, names: AgentNames): { readonly label: string; readonly value: string; readonly mono?: boolean }[] {
    const coordinator = project.members.coordinator;
    const places = folderPlacesOf(project).map((p) => p.machine);
    return [
        { label: 'Coordinator', value: coordinator ? names(coordinator).name : 'none' },
        { label: 'Members', value: project.members.agentIds.map((id) => names(id).name).join(', ') || 'none' },
        { label: 'Folder', value: places.length ? places.join(', ') : 'platform', mono: true },
        { label: 'Connectors', value: project.connectors.map((c) => connectorTagOf(c.id)).join(', ') || 'none', mono: true }
    ];
}

/** What the dashed Add-a-feature card suggests: code features for a project with a folder, event ones without. */
export function addFeatureHintOf(project: Pick<ProjectRecord, 'folders'>): string {
    return folderPlacesOf(project).length ? 'Docs, milestones, incidents, and more' : 'Guest list, travel, docs, and more';
}

/** The chat's state pill: label, and the `StatusPill` status it wears. */
export const CHAT_STATE_PILL: Readonly<Record<OverviewChatState, { readonly status: string; readonly label: string; readonly hollow?: boolean }>> = {
    'needs-you': { status: 'waiting', label: 'NEEDS YOU' },
    working: { status: 'running', label: 'WORKING' },
    idle: { status: 'queued', label: 'IDLE', hollow: true }
};

/** The chats the card lists: the five most recent. */
export const recentChatsOf = (chats: readonly OverviewChat[]): OverviewChat[] => [...chats].sort((a, b) => b.at - a.at).slice(0, RECENT_CHATS);
