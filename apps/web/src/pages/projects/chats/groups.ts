/**
 * The project Chats page's rules (#731, PRJ-04), pure so they are tested without a page: which group a chat sits in
 * (docs/design/projects/HANDOFF.md → "Project chats"), the search within the project, the chats outside every project
 * with the project each one suggests, and the line the defaults strip says.
 */
import type { ProjectRecord } from '@agentic/core';

/** Who acts next, in page order; `archived` is drawn collapsed. */
export const CHAT_GROUPS = ['needs-you', 'working', 'quiet', 'archived'] as const;
export type ChatGroup = (typeof CHAT_GROUPS)[number];

export const GROUP_LABELS: Readonly<Record<ChatGroup, string>> = { 'needs-you': 'Needs you', working: 'Agents working', quiet: 'Quiet', archived: 'Archived' };

/** A linked-work chip: a task, a pull request, or a count when a chat has more tasks than fit. */
export type WorkChip =
    | { readonly kind: 'task'; readonly id: string }
    | { readonly kind: 'pull'; readonly number: number }
    | { readonly kind: 'tasks'; readonly count: number };

/** One row of the page, the same shape on mock data and live. */
export interface ProjectChatRow {
    readonly id: string;
    readonly title: string;
    /** Who spoke last, when the line does not already say (`Forge`, `You`). */
    readonly speaker?: string;
    readonly lastLine: string;
    readonly agentIds: readonly string[];
    /** An approval or a question is open in the chat. */
    readonly waiting: boolean;
    /** A session in the chat is running: an agent works a task of the chat's tree. */
    readonly working: boolean;
    readonly archived?: boolean;
    readonly updatedAt: number;
    /** Absent when the chat is in no project. */
    readonly projectId?: string;
    readonly work: readonly WorkChip[];
}

/**
 * The group a chat sits in: archived before anything else, then an open approval or question (Needs you), then a
 * running session (Agents working), else Quiet — nothing running, nothing waiting.
 */
export function chatGroupOf(chat: Pick<ProjectChatRow, 'waiting' | 'working' | 'archived'>): ChatGroup {
    if (chat.archived) return 'archived';
    if (chat.waiting) return 'needs-you';
    if (chat.working) return 'working';
    return 'quiet';
}

/** Every word of `q` somewhere in the title or the last line (speaker included), case-insensitive; blank keeps all. */
export function matchesSearch(chat: Pick<ProjectChatRow, 'title' | 'lastLine' | 'speaker'>, q: string): boolean {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = `${chat.title}\n${chat.speaker ?? ''}\n${chat.lastLine}`.toLowerCase();
    return words.every((w) => text.includes(w));
}

/** The project's chats matching `q`, by group, newest activity first inside each; every group present, maybe empty. */
export function groupChats<T extends ProjectChatRow>(chats: readonly T[], projectId: string, q = ''): Record<ChatGroup, T[]> {
    const out: Record<ChatGroup, T[]> = { 'needs-you': [], working: [], quiet: [], archived: [] };
    for (const c of chats) if (c.projectId === projectId && matchesSearch(c, q)) out[chatGroupOf(c)].push(c);
    for (const g of CHAT_GROUPS) out[g].sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
}

/** The project a chat outside every project suggests: the first whose name it mentions as a word in its title or last line. */
export function suggestedProject<P extends { readonly id: string; readonly name: string }>(chat: Pick<ProjectChatRow, 'title' | 'lastLine'>, projects: readonly P[]): P | undefined {
    const text = `${chat.title}\n${chat.lastLine}`.toLowerCase();
    return projects.find((p) => {
        const name = p.name.trim().toLowerCase();
        if (!name) return false;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u').test(text);
    });
}

/** A chat outside every project, and whether it suggests this one. */
export interface UnassignedChat<T> {
    readonly chat: T;
    readonly suggested: boolean;
}

/** The live chats in no project, the ones suggesting `projectId` first, then newest first. */
export function unassignedChats<T extends ProjectChatRow>(chats: readonly T[], projects: readonly { readonly id: string; readonly name: string }[], projectId: string): UnassignedChat<T>[] {
    return chats
        .filter((c) => !c.projectId && !c.archived)
        .map((chat) => ({ chat, suggested: suggestedProject(chat, projects)?.id === projectId }))
        .sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.chat.updatedAt - a.chat.updatedAt);
}

/** `a`, `a and b`, `a, b and c`. */
export function listOf(items: readonly string[]): string {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A feature's name from its id: the registry's label when given, else the id's last segment capitalised (`agentic.feature.git` → Git). */
export function featureName(featureId: string, label?: string): string {
    if (label) return label;
    const last = featureId.split('.').pop() ?? featureId;
    return last ? last[0]!.toUpperCase() + last.slice(1) : featureId;
}

/** What the defaults strip says a new chat here inherits: where it starts, who coordinates, who is on hand, whose rules. */
export interface ChatDefaults {
    /** The project's folder (the first one it names), or `null` when it has none and runs on the platform. */
    readonly folder: string | null;
    readonly coordinator: string | null;
    readonly members: readonly string[];
    /** Enabled features that carry rules (an `instructions` string) for their chats. */
    readonly rules: readonly string[];
}

export function chatDefaults(project: Pick<ProjectRecord, 'folders' | 'members' | 'features'>, nameOf: (agentId: string) => string, labelOf: (featureId: string) => string | undefined = () => undefined): ChatDefaults {
    const folder = Object.values(project.folders).find((f): f is string => typeof f === 'string' && f.length > 0) ?? null;
    const coordinator = project.members.coordinator;
    const rules = Object.entries(project.features)
        .filter(([, config]) => typeof (config as { instructions?: unknown } | null)?.instructions === 'string' && ((config as { instructions: string }).instructions).trim() !== '')
        .map(([id]) => featureName(id, labelOf(id)));
    return {
        folder,
        coordinator: coordinator ? nameOf(coordinator) : null,
        members: project.members.agentIds.filter((id) => id !== coordinator).map(nameOf),
        rules
    };
}

/** The strip's sentence after the folder: `with Atlas coordinating, Forge and Lint on hand, and the Git feature's rules.` */
export function defaultsTail(d: Pick<ChatDefaults, 'coordinator' | 'members' | 'rules'>): string {
    const parts: string[] = [];
    if (d.coordinator) parts.push(`${d.coordinator} coordinating`);
    if (d.members.length) parts.push(`${listOf(d.members)} on hand`);
    const rules = d.rules.length ? `the ${listOf(d.rules)} ${d.rules.length === 1 ? 'feature’s' : 'features’'} rules` : '';
    if (!parts.length) return rules ? `with ${rules}.` : 'with nobody on hand yet.';
    return `with ${listOf(rules ? [...parts, rules] : parts)}.`;
}
