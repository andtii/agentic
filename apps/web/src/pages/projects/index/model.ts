/**
 * The projects index's view model (#729; PRJ-02): what a card says needs you, and the strips' lines. Pure, so the
 * mock board and the live one agree and the tests read it without mounting.
 */
import type { ProjectRecord } from '@agentic/core';
import type { Tone } from '@agentic/ui';

/** One card: the project and, when the source knows them, what needs you there. */
export interface ProjectCardData {
    readonly project: ProjectRecord;
    /** Items waiting on you; absent when the source does not count them (live, until the Work index lands). */
    readonly yourMove?: number;
    /** Agents working in the project now; absent as above. */
    readonly agentsOnIt?: number;
    /** The card's last line: `Next: merge #602 · review #598`, or what is going on. */
    readonly next?: string;
}

/** The open-links strip: hidden until the source has cross-project links (L1). */
export interface OpenLinksData {
    readonly count: number;
    /** `agentic 0.5 waits on signalx#14 · …`. */
    readonly summary: string;
}

/** The dashed strip: work outside any project. */
export interface UnassignedData {
    readonly chats: number;
    /** Absent when the source does not count tasks. */
    readonly tasks?: number;
}

export interface CardPill {
    readonly kind: 'move' | 'agents' | 'quiet';
    readonly label: string;
    readonly tone: Tone;
    readonly hollow?: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * `N YOUR MOVE`, `N AGENT(S) ON IT`, or `QUIET` when both are known and zero. Nothing when the source counts
 * neither: a card never claims a project is quiet without knowing.
 */
export function cardPills(card: Pick<ProjectCardData, 'yourMove' | 'agentsOnIt'>): readonly CardPill[] {
    const pills: CardPill[] = [];
    if (card.yourMove) pills.push({ kind: 'move', label: `${card.yourMove} YOUR MOVE`, tone: 'needs-you' });
    if (card.agentsOnIt) pills.push({ kind: 'agents', label: plural(card.agentsOnIt, 'AGENT ON IT', 'AGENTS ON IT'), tone: 'working' });
    if (!pills.length && card.yourMove !== undefined && card.agentsOnIt !== undefined) pills.push({ kind: 'quiet', label: 'QUIET', tone: 'dim', hollow: true });
    return pills;
}

/** `2 chats and 1 task are not in a project`; `''` when nothing is outside a project. */
export function unassignedText(u: UnassignedData | undefined): string {
    if (!u) return '';
    const parts = [u.chats ? plural(u.chats, 'chat', 'chats') : '', u.tasks ? plural(u.tasks, 'task', 'tasks') : ''].filter(Boolean);
    if (!parts.length) return '';
    const total = u.chats + (u.tasks ?? 0);
    return `${parts.join(' and ')} ${total === 1 ? 'is' : 'are'} not in a project`;
}

/** `4 open links across projects`. */
export const openLinksText = (l: OpenLinksData): string => `${plural(l.count, 'open link', 'open links')} across projects`;

/** A feature plugin id's tag: its last segment, lower case (`agentic.feature.git` → `git`). */
export const featureTag = (id: string): string => (id.split('.').at(-1) ?? id).toLowerCase();
