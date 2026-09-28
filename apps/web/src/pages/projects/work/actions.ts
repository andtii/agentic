/**
 * Clearing the Work view (#1040): the buttons on a task's row and on its work item page. **Stop** cancels a queued,
 * running or waiting task (`Task.cancel`, COL-12); **Dismiss** clears a failed one for every viewer (`Task.dismiss`,
 * kept on its TaskIndex row); **Retry** posts the failed task's brief again to the same agent in the same chat — the
 * activation a message starts, so the new task stays in the project — then dismisses the failed one.
 *
 * Stop and Dismiss take no confirm but offer an Undo: a stop waits `WORK_UNDO_MS` before it is sent (a cancel cannot
 * be taken back), a dismiss is sent at once and undone with `Task.dismiss(by, false)`. The row leaves the view at once
 * either way. One notice at a time (`workNotice`), module-wide so the work item page can act and hand over to Work.
 */
import { signal } from 'sigx';
import { actor } from '@sigx/actors';
import { createId, type AgentId, type ChatId, type TaskId } from '@agentic/core';
import type { ActorDefs } from '../../../actors/defs';
import { chatKeyOf, routingKeyOf, taskKeyOf } from '../../../actors/keys';
import { runActivation, type AgentLookup } from '../../chat/live';
import type { WorkAction } from './model';

/** How long a Stop can be undone before the cancel is sent. */
export const WORK_UNDO_MS = 6_000;

/** Who the Work view's actions are by, as the task's history records it. */
export const WORK_ACTION_BY = 'user';

/** What the buttons call: live the Task actor and the chat, in tests a fake. */
export interface WorkActions {
    stop(taskId: TaskId): Promise<unknown>;
    dismiss(taskId: TaskId, dismissed: boolean): Promise<unknown>;
    /** Start the failed task's brief again; resolves once the new task is routed. */
    retry(taskId: TaskId): Promise<unknown>;
}

/** The one notice under the Work view: what was just done, whether it can be undone, or what failed. */
export const workNotice = signal({ text: '', undo: false, error: '' });
/** Task ids the view leaves out right away, before the index catches up (and while a stop can still be undone). */
export const workHidden = signal({ ids: [] as string[] });

let pending: { readonly action: 'stop' | 'dismiss'; readonly taskId: TaskId; readonly actions: WorkActions; timer?: ReturnType<typeof setTimeout> } | undefined;
/** Bumped by every action: a late failure only speaks when no newer action has taken the notice. */
let noticeSeq = 0;

const hide = (id: string): void => {
    if (!workHidden.ids.includes(id)) workHidden.ids = [...workHidden.ids, id];
};
const show = (id: string): void => {
    workHidden.ids = workHidden.ids.filter((x) => x !== id);
};
const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * End the Undo window of the last Stop or Dismiss (another action, or the notice closing, ends it): a Stop is sent
 * now. Either way the row stops being hidden here once the server has it — the index then leaves it out on its own —
 * so hidden ids do not pile up or outlive a dismissal someone else undoes.
 */
export function flushWorkAction(): void {
    const p = pending;
    pending = undefined;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.action === 'dismiss') {
        show(p.taskId);
        return;
    }
    const seq = noticeSeq;
    p.actions.stop(p.taskId).then(
        () => show(p.taskId),
        (e: unknown) => {
            show(p.taskId);
            if (seq !== noticeSeq) return;
            workNotice.text = '';
            workNotice.undo = false;
            workNotice.error = `Could not stop it: ${failed(e)}`;
        }
    );
}

/** Run one action on a task's row; `title` names it in the notice. */
export async function runWorkAction(actions: WorkActions, action: WorkAction, taskId: TaskId, title: string): Promise<void> {
    flushWorkAction();
    const seq = ++noticeSeq;
    workNotice.error = '';
    if (action === 'stop') {
        hide(taskId);
        const p: NonNullable<typeof pending> = { action, taskId, actions };
        p.timer = setTimeout(() => {
            if (pending === p) flushWorkAction();
        }, WORK_UNDO_MS);
        pending = p;
        workNotice.text = `Stopping “${title}”`;
        workNotice.undo = true;
        return;
    }
    hide(taskId);
    try {
        if (action === 'dismiss') {
            await actions.dismiss(taskId, true);
            // A newer action took the notice meanwhile: this one is done, with no Undo left to offer.
            if (seq !== noticeSeq) return show(taskId);
            pending = { action, taskId, actions };
            workNotice.text = `Dismissed “${title}”`;
            workNotice.undo = true;
        } else {
            await actions.retry(taskId);
            show(taskId);
            if (seq !== noticeSeq) return;
            workNotice.text = `Started “${title}” again`;
            workNotice.undo = false;
        }
    } catch (e) {
        show(taskId);
        if (seq !== noticeSeq) return;
        workNotice.text = '';
        workNotice.undo = false;
        workNotice.error = `Could not ${action} it: ${failed(e)}`;
    }
}

/** Undo the last Stop (not sent yet) or Dismiss. */
export async function undoWorkAction(): Promise<void> {
    ++noticeSeq;
    const p = pending;
    pending = undefined;
    workNotice.text = '';
    workNotice.undo = false;
    if (!p) return;
    clearTimeout(p.timer);
    show(p.taskId);
    if (p.action === 'dismiss') {
        try {
            await p.actions.dismiss(p.taskId, false);
        } catch (e) {
            hide(p.taskId);
            workNotice.error = `Could not undo: ${failed(e)}`;
        }
    }
}

/** Close the notice; a Stop still in its Undo window is sent now. */
export function closeWorkNotice(): void {
    flushWorkAction();
    workNotice.text = '';
    workNotice.undo = false;
    workNotice.error = '';
}

/** The live actions: the Task actor for stop and dismiss, the task's own chat for a retry. */
export function liveWorkActions(defs: ActorDefs, ws: string, lookup: AgentLookup): WorkActions {
    const task = (id: TaskId) => actor(defs.TaskActor, taskKeyOf(ws, id));
    return {
        stop: (id) => task(id).cancel(WORK_ACTION_BY),
        dismiss: (id, dismissed) => task(id).dismiss(WORK_ACTION_BY, dismissed),
        async retry(id) {
            const view = await task(id).get();
            if (view.origin.kind !== 'user') throw new Error('only a task started in a chat can be retried here');
            const chatId = view.origin.chatId as ChatId;
            const chat = actor(defs.Chat, chatKeyOf(ws, chatId));
            const agentId = view.assignee as AgentId;
            const [summary, history] = await Promise.all([chat.get(), chat.history(null, 50)]);
            await runActivation(
                {
                    post: (text, mentions) => chat.post(text, mentions),
                    createTask: (newId, contract, owner) => actor(defs.TaskActor, taskKeyOf(ws, newId)).create(contract, { owner }),
                    run: (newId) => actor(defs.Routing, routingKeyOf(ws)).run(newId),
                    newTaskId: () => createId('task') as TaskId
                },
                { chatId, text: view.objective, mentions: [agentId], summary, entries: history.entries, lookup }
            );
            await task(id).dismiss(WORK_ACTION_BY, true);
        }
    };
}
