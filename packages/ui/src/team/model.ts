/**
 * The pure side of the team parts (#1057): a member's product state, its governed lifecycle, and the
 * times and counts the parts print.
 */
import type { AgentHue } from '../kit/AgentTile.js';
import { formatElapsed } from '../transcript/LiveLine.js';
import type { TEAM_STATES } from './anatomy.js';

/** What a crew member is doing: working, waiting on you, idle (waiting on others), done, failed. */
export type CrewState = 'working' | 'needs-you' | 'idle' | 'done' | 'failed';
export const CREW_STATES: readonly CrewState[] = ['working', 'needs-you', 'idle', 'done', 'failed'];

export type TeamLifecycle = (typeof TEAM_STATES)[number];

const LIFECYCLE: Record<CrewState, TeamLifecycle> = {
    working: 'running',
    'needs-you': 'loading',
    idle: 'paused',
    done: 'complete',
    failed: 'error'
};

/** A member's `data-state`: the governed lifecycle value its product state maps onto. */
export function crewLifecycle(state: CrewState): TeamLifecycle {
    return LIFECYCLE[state];
}

const LABELS: Record<CrewState, string> = { working: 'working', 'needs-you': 'waits on you', idle: 'idle', done: 'done', failed: 'failed' };

/** The accessible name of a member's state mark. */
export function crewStateLabel(state: CrewState): string {
    return LABELS[state];
}

/** An agent as the parts draw it: its name and identity slot. */
export interface TeamAgent {
    readonly name: string;
    readonly hue?: AgentHue;
}

/** One chip of the crew strip. */
export interface CrewMember extends TeamAgent {
    /** The member's key (its agent id): what `follow` emits. */
    readonly id: string;
    readonly state: CrewState;
    /** When its current turn started (epoch ms); no time without it. */
    readonly startedAt?: number;
    /** When it ended; the time stops there. */
    readonly endedAt?: number;
    /** The second line: the current step (`Bash · npx sigx zero:build`) or a note (`done · fragments pass`). */
    readonly step?: string;
    /** What it asks you, shown as `asks you: …` while it waits on you. */
    readonly ask?: string;
}

/** The time since `startedAt`, stopped at `endedAt`; `–` without a start. */
export function elapsedOf(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
    if (startedAt === undefined) return '–';
    return formatElapsed((endedAt ?? now) - startedAt);
}

/** `23 steps · 4m 12s` — the count, then the time when there is one. */
export function formatWorkMeta(steps: number, elapsed?: string): string {
    const count = `${steps} ${steps === 1 ? 'step' : 'steps'}`;
    return elapsed && elapsed !== '–' ? `${count} · ${elapsed}` : count;
}

/** `Forge and Lint exchanged 4 messages`; three or more names read `A, B and C`. */
export function formatFoldedTalk(names: readonly string[], count: number): string {
    const who = names.length <= 1 ? (names[0] ?? 'Agents') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${who} exchanged ${count} ${count === 1 ? 'message' : 'messages'}`;
}
