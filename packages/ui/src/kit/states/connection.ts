/**
 * The connection strip's rows from the two signals it shows
 * (`docs/design/HANDOFF.md` → "Layout and shell", "Failure distinction"):
 * this browser's socket (`live` / `reconnecting…`) and each machine
 * (`online` with its session count, or `offline` with the age). Pure
 * functions: the page reads the signals, the strip draws the rows. The
 * hollow dot is reserved for the states where nothing is happening
 * (offline, unknown).
 */
import type { ConnectionRow } from '../ConnectionStrip.js';

export type BrowserConnection = 'live' | 'reconnecting';

export interface MachineConnection {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    /** Active sessions while online; omit when unknown and the row reads `online`. */
    readonly sessions?: number;
    /** Relative age of the last heartbeat while offline, e.g. "3h". */
    readonly lastSeen?: string;
}

export function browserRow(state: BrowserConnection): ConnectionRow {
    return state === 'live'
        ? { id: 'browser', name: 'This browser', state: 'live', tone: 'live' }
        : { id: 'browser', name: 'This browser', state: 'reconnecting…', tone: 'muted', hollow: true };
}

export function machineRow(machine: MachineConnection): ConnectionRow {
    if (machine.online) {
        // A count is shown only when the caller knows it; an unknown count is plain `online`, never "0 sessions".
        const n = machine.sessions;
        const state = n === undefined ? 'online' : `${n} ${n === 1 ? 'session' : 'sessions'}`;
        return { id: machine.id, name: machine.name, state, tone: 'live' };
    }
    return { id: machine.id, name: machine.name, state: machine.lastSeen ? `offline ${machine.lastSeen}` : 'offline', tone: 'muted', hollow: true };
}

/** The whole strip: the browser first, then every machine in the order given. */
export function connectionRows(browser: BrowserConnection, machines: readonly MachineConnection[]): ConnectionRow[] {
    return [browserRow(browser), ...machines.map(machineRow)];
}
