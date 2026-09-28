/**
 * The Work view's row actions (#1040, PRJ-05, COL-12): Stop, Dismiss and Retry on a task row, and on its work item
 * page. The live calls are ports (`LiveWork.ts` wires them to the Task actor and the Start task path); this holds
 * what the board needs meanwhile — the rows to keep off it, the rows mid-call — and the Undo toasts.
 *
 * - **Stop** needs no confirm: the row leaves at once and an Undo toast shows for `UNDO_MS`; only when the toast runs
 *   out is the task cancelled (`TaskActor.cancel`), since a cancel cannot be taken back. Leaving the page does not
 *   drop it: `flush` (and `pagehide`) cancels whatever is still waiting.
 * - **Dismiss** is recorded on the task at once (`TaskActor.dismiss`); Undo calls `undismiss`.
 * - **Retry** starts a new task for the same agent with the same objective, then dismisses the failed one.
 */
import { signal } from 'sigx';
import { toaster, type ToastOptions } from '@sigx/zero';
import type { WorkAction } from './model';

/** How long a Stop or Dismiss can be undone. */
export const UNDO_MS = 5_000;

/** The live calls behind the actions, by task id. */
export interface WorkActionPorts {
    cancel(taskId: string): Promise<unknown>;
    dismiss(taskId: string): Promise<unknown>;
    undismiss(taskId: string): Promise<unknown>;
    /** Start a new task for the same agent with the same objective (the Start task path). */
    retry(taskId: string): Promise<unknown>;
}

/** Where the Undo toasts go: the app's toaster in the browser, a fake in tests. */
export interface WorkNotifier {
    show(options: ToastOptions): string;
    close(id: string): void;
}

/** The task a row acts on. */
export interface WorkActionTarget {
    readonly id: string;
    readonly title: string;
}

export interface WorkActions {
    /** The row is held off the board: a Stop waiting out its Undo, or a Dismiss or Retry that went through. */
    hidden(taskId: string): boolean;
    /** A call for the row is in flight. */
    busy(taskId: string): boolean;
    /** Take an action; `false` when it was not taken (the row is busy with another call). */
    run(action: WorkAction, task: WorkActionTarget, ports: WorkActionPorts): Promise<boolean>;
    /** Cancel every Stop still waiting out its Undo, now. */
    flush(): void;
}

export interface WorkActionsOptions {
    readonly notifier?: WorkNotifier;
    readonly undoMs?: number;
}

const browserNotifier: WorkNotifier = {
    show: (options) => toaster().create(options),
    close: (id) => toaster().dismiss(id)
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createWorkActions(options: WorkActionsOptions = {}): WorkActions {
    const notifier = options.notifier ?? browserNotifier;
    const undoMs = options.undoMs ?? UNDO_MS;
    const st = signal({ hidden: [] as string[], busy: [] as string[] });
    const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; toast: string; fire: () => void }>();
    const add = (key: 'hidden' | 'busy', id: string): void => { if (!st[key].includes(id)) st[key] = [...st[key], id]; };
    const drop = (key: 'hidden' | 'busy', id: string): void => { st[key] = st[key].filter((x) => x !== id); };
    const failed = (what: string, task: WorkActionTarget, e: unknown): void => {
        drop('hidden', task.id);
        notifier.show({ title: `Could not ${what} “${task.title}”`, description: messageOf(e), color: 'error', role: 'alert' });
    };

    const stop = (task: WorkActionTarget, ports: WorkActionPorts): void => {
        if (pending.has(task.id)) return;
        add('hidden', task.id);
        const fire = (): void => {
            const p = pending.get(task.id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(task.id);
            add('busy', task.id);
            void ports.cancel(task.id)
                .catch((e: unknown) => failed('stop', task, e))
                .finally(() => drop('busy', task.id));
        };
        const toast = notifier.show({
            title: `Stopped “${task.title}”`,
            duration: undoMs,
            action: {
                label: 'Undo',
                onClick: () => {
                    const p = pending.get(task.id);
                    if (!p) return;
                    clearTimeout(p.timer);
                    pending.delete(task.id);
                    drop('hidden', task.id);
                    notifier.close(p.toast);
                }
            }
        });
        pending.set(task.id, { timer: setTimeout(fire, undoMs), toast, fire });
    };

    const dismiss = async (task: WorkActionTarget, ports: WorkActionPorts): Promise<void> => {
        add('hidden', task.id);
        add('busy', task.id);
        try {
            await ports.dismiss(task.id);
        } catch (e) {
            failed('dismiss', task, e);
            return;
        } finally {
            drop('busy', task.id);
        }
        const toast = notifier.show({
            title: `Dismissed “${task.title}”`,
            duration: undoMs,
            action: {
                label: 'Undo',
                onClick: () => {
                    notifier.close(toast);
                    drop('hidden', task.id);
                    void ports.undismiss(task.id).catch((e: unknown) => {
                        add('hidden', task.id);
                        notifier.show({ title: `Could not undo dismissing “${task.title}”`, description: messageOf(e), color: 'error', role: 'alert' });
                    });
                }
            }
        });
    };

    const retry = async (task: WorkActionTarget, ports: WorkActionPorts): Promise<void> => {
        add('busy', task.id);
        try {
            await ports.retry(task.id);
        } catch (e) {
            drop('busy', task.id);
            failed('retry', task, e);
            return;
        }
        // The new task is started: the failed one leaves Work.
        add('hidden', task.id);
        try {
            await ports.dismiss(task.id);
        } catch (e) {
            // The retry went through; the failure stays on Work, so it can still be dismissed by hand.
            drop('hidden', task.id);
            notifier.show({ title: `Retrying “${task.title}” — the failed task could not be dismissed`, description: messageOf(e), color: 'error', role: 'alert' });
            return;
        } finally {
            drop('busy', task.id);
        }
        notifier.show({ title: `Retrying “${task.title}”`, description: 'A new task started with the same agent and brief.' });
    };

    return {
        hidden: (id) => st.hidden.includes(id),
        busy: (id) => st.busy.includes(id),
        async run(action, task, ports) {
            if (st.busy.includes(task.id) || pending.has(task.id)) return false;
            if (action === 'stop') stop(task, ports);
            else if (action === 'dismiss') await dismiss(task, ports);
            else await retry(task, ports);
            return true;
        },
        flush() {
            for (const p of [...pending.values()]) p.fire();
        }
    };
}

let shared: WorkActions | undefined;

/**
 * The app's one set of row actions: the Work view and the work item page share it, so a Stop started on the item page
 * still counts down (and can be undone) on the Work view it goes back to. Browser only.
 */
export function workActions(): WorkActions {
    if (!shared) {
        const created = createWorkActions();
        shared = created;
        // A Stop still waiting out its Undo is sent before the page goes.
        if (typeof window !== 'undefined') window.addEventListener('pagehide', () => created.flush());
    }
    return shared;
}
