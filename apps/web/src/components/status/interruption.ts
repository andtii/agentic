/**
 * Why a turn was cut short and what happens next (#368; OPS-04, OPS-05,
 * OPS-06), and the machine-offline wait. Pure: a page gathers what it has —
 * the Audit's `session.interrupted` / `session.resumed` rows (the daemon's
 * close code as `host`, the machine as `by: machine:{id}`), or the cut read
 * straight from the session log, plus the router's route (`rehosting`, the
 * frozen `onInterrupt`, `autoResumed`) — into an `Interruption`, and the
 * failure card, the chat's status row, the task node and the session page
 * all say it the same way:
 *
 *   restart         · "the daemon on alien01 restarted"
 *   update          · "alien01 was updated"
 *   harness-update  · "the claude-code harness on alien01 was updated"
 *   any other code  · "the session on alien01 ended"
 *   no audit row    · "the platform restarted mid-turn" (an eviction)
 *
 * The browser bundle never imports the platform: its names are types only,
 * and the router's `MACHINE_LOST_MS` (24 h) is spelled here in hours
 * (`MACHINE_LOST_HOURS`).
 */
import type { SessionClosedCode, WaitReason } from '@agentic/core';
import type { AuditEvent } from '@agentic/platform';

/** The cut's cause as `session.interrupted` records it: the daemon's close code, `closed` when it gave none. */
export type InterruptHost = SessionClosedCode | 'closed';

/**
 * What happens next: `ask` — a person resumes; `resuming` — the route re-opens the session on its machine;
 * `auto` — the agent's `onInterrupt: 'auto'` resumes it once, on its own; `resumed` — it went on.
 */
export type ResumeState = 'ask' | 'resuming' | 'auto' | 'resumed';

export interface Interruption {
    /** The close code; absent when nothing recorded one (the platform evicted the session). */
    readonly host?: InterruptHost;
    readonly machineId?: string;
    /** The machine's name, else its id. */
    readonly machine?: string;
    /** The runtime whose harness an `harness-update` replaced. */
    readonly runtime?: string;
    readonly resume?: ResumeState;
    /** Resumed by the router (`onInterrupt: 'auto'`), not a person. */
    readonly auto?: boolean;
}

/** The slice of a router `Route` this reads (`Routing.get()`, live). */
export interface RouteSignal {
    readonly taskId: string;
    readonly status: string;
    readonly sessionId?: string;
    readonly machineId?: string;
    readonly runtime?: string;
    readonly turnId?: string;
    readonly rehosting?: boolean;
    readonly autoResumed?: string;
    readonly config: { readonly execution?: { readonly onInterrupt?: 'ask' | 'auto' } };
}

/** How long a machine may stay offline under a running turn before the task fails `machine-lost`: the router's `MACHINE_LOST_MS` (#366) in hours. */
export const MACHINE_LOST_HOURS = 24;

/** The router's `machine-lost` failure code (`MACHINE_LOST_CODE`). */
export const MACHINE_LOST_CODE = 'machine-lost';

/** The audit kinds an interruption is read from. */
export const INTERRUPTION_KINDS = ['session.interrupted', 'session.resumed', 'task.machine-lost'] as const;

/** Who the router acts as (`ROUTER`): a resume `by` it is an `auto` one. */
const ROUTER = 'system:routing';

/** The cut turn a resume turn id names (`{turnId}:resume`, maybe repeated). */
export const baseTurnId = (turnId: string): string => turnId.replace(/(?::resume)+$/, '');

/** The cause, lower-case, without a full stop: "the daemon on alien01 restarted". */
export function interruptionCause(i: Interruption | null | undefined): string {
    if (!i || (i.host === undefined && !i.machine)) return 'the platform restarted mid-turn';
    const m = i.machine ?? 'the machine';
    switch (i.host) {
        case 'restart':
            return `the daemon on ${m} restarted`;
        case 'update':
            return `${m} was updated`;
        case 'harness-update':
            return `the ${i.runtime ?? 'runtime'} harness on ${m} was updated`;
        default:
            return `the session on ${m} ended`;
    }
}

/** The one-line account (a chat status row, a session or task note): the cause, then where the resume stands. */
export function interruptionLine(i: Interruption | null | undefined): string {
    const cause = `interrupted: ${interruptionCause(i)}`;
    switch (i?.resume) {
        case 'resumed':
            return `${cause} · resumed${i.auto ? ' automatically' : ''}`;
        case 'auto':
            return `${cause} · resuming automatically`;
        case 'resuming':
            return `${cause} · resuming…`;
        default:
            return cause;
    }
}

const machineOf = (by: string): string | undefined => (by.startsWith('machine:') && by !== 'machine:unknown' ? by.slice('machine:'.length) : undefined);

/** A route parked `interrupted`: re-opening, about to resume on its own (once per cut turn), or waiting for a person. */
export function routeResume(route: RouteSignal): ResumeState | undefined {
    if (route.status !== 'interrupted') return undefined;
    if (route.rehosting) return 'resuming';
    const cut = route.turnId ? baseTurnId(route.turnId) : undefined;
    return route.config.execution?.onInterrupt === 'auto' && route.autoResumed !== cut ? 'auto' : 'ask';
}

export interface InterruptionInput {
    /** Audit rows of `INTERRUPTION_KINDS`, newest first (`Audit.list`). */
    readonly audit?: readonly AuditEvent[];
    /** The task the cut turn worked. */
    readonly taskId?: string;
    /** The cut turn (the chat's `interrupted:{turnId}` row), when known. */
    readonly turnId?: string;
    /** The router's route for the task, when it still has one. */
    readonly route?: RouteSignal | null;
    /** The cut read from the session log instead of the audit (the Session page): the `error` event's `data.host`. */
    readonly cut?: { readonly host?: InterruptHost; readonly resumed?: boolean; readonly machineId?: string; readonly runtime?: string; readonly auto?: boolean };
    /** A machine id → its name. */
    readonly machineName?: (id: string) => string | undefined;
}

/**
 * The interruption a page shows, or `null` when nothing names one. The newest `session.interrupted` row for the
 * turn (else the task) gives the cause, a `session.resumed` row of the task at or after it says it went on, and
 * the route — while it is still parked — says where the resume stands.
 */
export function interruptionOf(input: InterruptionInput): Interruption | null {
    const { audit = [], taskId, turnId, route, cut, machineName } = input;
    const base = turnId ? baseTurnId(turnId) : undefined;
    const row = audit.find((e) => e.kind === 'session.interrupted' && (base ? e.data.turnId === base : taskId !== undefined && e.data.taskId === taskId));
    const interrupted = row?.kind === 'session.interrupted' ? row : undefined;
    const task = taskId ?? interrupted?.data.taskId ?? (base ? route?.taskId : undefined);
    const resumedRow = audit.find((e) => e.kind === 'session.resumed' && e.data.taskId === task && (!interrupted || e.at >= interrupted.at));
    const resumed = resumedRow?.kind === 'session.resumed' ? resumedRow : undefined;
    const parked = route && route.status === 'interrupted' ? route : undefined;
    if (!interrupted && !cut && !parked && !resumed) return null;
    const host = cut ? cut.host : interrupted?.data.host;
    const machineId = cut?.machineId ?? route?.machineId ?? (interrupted ? machineOf(interrupted.by) : undefined);
    // Neither a machine nor a code: the platform evicted the session (`interruptionCause`).
    const machine = machineId !== undefined ? (machineName?.(machineId) ?? machineId) : undefined;
    const runtime = cut?.runtime ?? route?.runtime;
    const resume: ResumeState | undefined = parked ? routeResume(parked) : resumed || cut?.resumed ? 'resumed' : undefined;
    const auto = resume === 'resumed' ? (resumed ? resumed.data.by === ROUTER : cut?.auto) : undefined;
    return {
        ...(host !== undefined ? { host } : {}),
        ...(machineId !== undefined ? { machineId, machine } : {}),
        ...(runtime ? { runtime } : {}),
        ...(resume ? { resume } : {}),
        ...(auto ? { auto: true } : {})
    };
}

/**
 * The cut as the session log has it (the Session page reads `Session.events`): the newest interrupted `error`
 * event's `data.host`, and whether a `{turnId}:resume` turn started after it. `null` when no turn was cut.
 */
export function cutOfEvents(events: readonly { readonly type: string; readonly turnId?: string; readonly code?: string; readonly data?: unknown }[]): { host?: InterruptHost; resumed: boolean } | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]!;
        if (ev.type !== 'error' || ev.code !== 'process_exited') continue;
        const data = (ev.data ?? {}) as { interrupted?: boolean; host?: InterruptHost };
        if (!data.interrupted) continue;
        const cut = ev.turnId ? baseTurnId(ev.turnId) : undefined;
        const resumed = cut !== undefined && events.slice(i + 1).some((e) => e.type === 'turn-start' && e.turnId !== undefined && e.turnId !== ev.turnId && baseTurnId(e.turnId) === cut);
        return { ...(data.host ? { host: data.host } : {}), resumed };
    }
    return null;
}

/** "14:02" — the page's clock face for an instant. */
export type ClockText = (at: number) => string;

/** A task waiting on its machine (#366): "Waiting for alien01 (offline since 14:02); fails after 24 h". */
export function machineOfflineText(wait: Extract<WaitReason, { kind: 'machine-offline' }>, name: string | undefined, time: ClockText): string {
    return `Waiting for ${name ?? wait.machineId} (offline since ${time(wait.since)}); fails after ${MACHINE_LOST_HOURS} h`;
}

/**
 * A chat's message parked on its environment's capacity (#652; EXE-09): "Waiting for a free slot on Work (alien01):
 * 1 of 1 turns running · 2nd in line". `slots` is the environment's live count, absent while it is not known.
 */
export function capacityWaitText(wait: Extract<WaitReason, { kind: 'capacity' }>, where: { readonly environment?: string; readonly machine?: string }, slots?: { readonly active: number; readonly max?: number }): string {
    const env = where.environment ?? wait.environmentId;
    const parts = [`Waiting for a free slot on ${where.machine ? `${env} (${where.machine})` : env}`];
    if (slots?.max !== undefined) parts[0] += `: ${slots.active} of ${slots.max} ${slots.max === 1 ? 'turn' : 'turns'} running`;
    if (wait.position > 1) parts.push(`${ordinal(wait.position)} in line`);
    return parts.join(' · ');
}

const ordinal = (n: number): string => {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
    return `${n}${suffix}`;
};

/** The same wait on a node or a table row, after `wait: machine-offline`: "alien01 offline since 14:02 · fails after 24 h". */
export function machineOfflineDetail(wait: Extract<WaitReason, { kind: 'machine-offline' }>, name: string | undefined, time: ClockText): string {
    return `${name ?? wait.machineId} offline since ${time(wait.since)} · fails after ${MACHINE_LOST_HOURS} h`;
}

/** The machine a `machine-lost` failure names: its message says `machine {id} has been offline since …`. */
export function lostMachineOf(message: string): string | undefined {
    return /machine (\S+) has been offline/.exec(message)?.[1];
}
