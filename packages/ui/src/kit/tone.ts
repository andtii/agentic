/**
 * The one visual per domain state (`docs/design/HANDOFF.md` → "Task
 * status", "Tool call", Machines). Every status the platform can show maps
 * to a tone, a solid or hollow dot, and its label; a state that is not in
 * this table renders as free text in the muted tone. If core gains a state,
 * add its row here before it reaches a screen.
 */
import type { TaskStatus, WaitReason } from '@agentic/core';
import type { Tone } from './vocabulary.js';

/**
 * The zero colour role a tone paints with — what `Badge`, `EmptyState`,
 * `Progress` and `Timeline.Marker` take as `color`. Both greys (`muted`,
 * `dim`) are `neutral`, which the design system's patches draw as the
 * muted ink; the tone itself stays on the root as `data-tone`.
 */
export type ToneRole = 'primary' | 'info' | 'warning' | 'error' | 'neutral';

export const TONE_ROLES: Record<Tone, ToneRole> = {
    live: 'primary',
    working: 'info',
    'needs-you': 'warning',
    failed: 'error',
    muted: 'neutral',
    dim: 'neutral'
};

/** The colour role for a tone. */
export function roleOf(tone: Tone): ToneRole {
    return TONE_ROLES[tone];
}

/** A row of the table: the tone, the dot, the label. */
export interface PillSpec {
    readonly tone: Tone;
    /** A ring instead of a filled dot: nothing is happening (queued, cancelled, offline, unknown, denied). */
    readonly hollow: boolean;
    readonly label: string;
}

/** A row plus the colour role its tone paints with — what `pillFor` answers. */
export interface PillLook extends PillSpec {
    readonly role: ToneRole;
}

/** Task status, machine presence, auth, tool-call phases — every enum the pill shows. */
export const PILLS = {
    queued: { tone: 'muted', hollow: true, label: 'QUEUED' },
    active: { tone: 'working', hollow: false, label: 'ACTIVE' },
    waiting: { tone: 'needs-you', hollow: false, label: 'WAITING' },
    completed: { tone: 'muted', hollow: false, label: 'COMPLETED' },
    failed: { tone: 'failed', hollow: false, label: 'FAILED' },
    cancelled: { tone: 'dim', hollow: true, label: 'CANCELLED' },
    online: { tone: 'live', hollow: false, label: 'ONLINE' },
    offline: { tone: 'muted', hollow: true, label: 'OFFLINE' },
    unknown: { tone: 'muted', hollow: true, label: 'UNKNOWN' },
    'auth-ok': { tone: 'live', hollow: false, label: 'AUTH OK' },
    'auth-expired': { tone: 'failed', hollow: false, label: 'AUTH EXPIRED' },
    'auth-missing': { tone: 'failed', hollow: false, label: 'NOT SIGNED IN' },
    pending: { tone: 'muted', hollow: true, label: 'PENDING' },
    running: { tone: 'working', hollow: false, label: 'RUNNING' },
    done: { tone: 'muted', hollow: false, label: 'DONE' },
    error: { tone: 'failed', hollow: false, label: 'ERROR' },
    denied: { tone: 'failed', hollow: true, label: 'DENIED' },
    streaming: { tone: 'working', hollow: false, label: 'STREAMING' },
    live: { tone: 'live', hollow: false, label: 'LIVE' },
    verified: { tone: 'live', hollow: false, label: 'VERIFIED' },
    'not-verified': { tone: 'muted', hollow: true, label: 'NOT VERIFIED' },
    reported: { tone: 'muted', hollow: false, label: 'REPORTED' },
    'partly-estimated': { tone: 'needs-you', hollow: false, label: 'PARTLY ESTIMATED' },
    'not-reported': { tone: 'dim', hollow: true, label: 'NOT REPORTED' },
    'needs-review': { tone: 'needs-you', hollow: false, label: 'NEEDS REVIEW' },
    interrupted: { tone: 'failed', hollow: false, label: 'INTERRUPTED' },
    approval: { tone: 'needs-you', hollow: false, label: 'APPROVAL' },
    input: { tone: 'needs-you', hollow: false, label: 'INPUT' }
} as const satisfies Record<string, PillSpec>;

export type PillStatus = keyof typeof PILLS;
/** Compile-time proof that every `TaskStatus` has a row. */
const _everyTaskStatus: Record<TaskStatus, PillSpec> = PILLS;
void _everyTaskStatus;

/** The pill for a status, with its role; unknown strings are free text in the muted tone with a solid dot. */
export function pillFor(status: string): PillLook {
    const row: PillSpec = (PILLS as Record<string, PillSpec>)[status] ?? { tone: 'muted', hollow: false, label: status };
    return { ...row, role: roleOf(row.tone) };
}

/**
 * The wait line that always follows WAITING, in the literal core names:
 * `wait: approval`, `wait: environment-offline · policy queue`,
 * `wait: child · 2 tasks`, plus the free `detail` a caller knows
 * (`· git push`).
 */
export function waitText(wait: WaitReason, detail?: string): string {
    const parts = [`wait: ${wait.kind}`];
    switch (wait.kind) {
        case 'environment-offline':
            parts.push(`policy ${wait.policy}`);
            break;
        case 'child':
            parts.push(`${wait.childTaskIds.length} ${wait.childTaskIds.length === 1 ? 'task' : 'tasks'}`);
            break;
        case 'capacity':
            parts.push(`position ${wait.position}`);
            break;
        case 'budget':
            parts.push(String(wait.limit));
            break;
        default:
            break;
    }
    if (detail) parts.push(detail);
    return parts.join(' · ');
}
