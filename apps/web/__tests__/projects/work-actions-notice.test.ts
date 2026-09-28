/**
 * The Work view's action notice (#1040), over fake actions: a hidden row is shown again once its action is done on
 * the server (so hidden ids never pile up or outlive a dismissal someone else undoes), and a late failure never
 * overwrites the notice of a newer action.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '@agentic/core';
import { closeWorkNotice, runWorkAction, undoWorkAction, workHidden, workNotice, type WorkActions } from '../../src/pages/projects/work/actions';

const settle = () => new Promise((r) => setTimeout(r, 0));
const calls: string[] = [];
let failStop: ((e: Error) => void) | undefined;
const actions: WorkActions = {
    stop: (id) => {
        calls.push(`stop ${id}`);
        return new Promise((_, reject) => (failStop = reject));
    },
    dismiss: async (id, d) => void calls.push(`dismiss ${id} ${d}`),
    retry: async (id) => void calls.push(`retry ${id}`)
};
const T = (id: string) => id as TaskId;

afterEach(() => {
    closeWorkNotice();
    workHidden.ids = [];
    calls.length = 0;
});

describe('the Work action notice (#1040)', () => {
    it('a dismissed row is hidden while its Undo is offered and shown again once the window ends', async () => {
        await runWorkAction(actions, 'dismiss', T('t1'), 'one');
        expect(workHidden.ids).toEqual(['t1']);
        expect(workNotice).toMatchObject({ text: 'Dismissed “one”', undo: true });
        closeWorkNotice();
        expect(workHidden.ids).toEqual([]);
        expect(calls).toEqual(['dismiss t1 true']);
    });

    it('Undo on a stop sends nothing; a retry leaves nothing hidden', async () => {
        await runWorkAction(actions, 'stop', T('t2'), 'two');
        expect(workHidden.ids).toEqual(['t2']);
        await undoWorkAction();
        expect(workHidden.ids).toEqual([]);
        await runWorkAction(actions, 'retry', T('t3'), 'three');
        expect(workHidden.ids).toEqual([]);
        expect(calls).toEqual(['retry t3']);
    });

    it('a stop that fails after a newer action does not overwrite the newer notice', async () => {
        await runWorkAction(actions, 'stop', T('t4'), 'four');
        // The next action ends the stop's window: the stop is sent, still in flight.
        await runWorkAction(actions, 'dismiss', T('t5'), 'five');
        expect(calls).toEqual(['stop t4', 'dismiss t5 true']);
        failStop!(new Error('offline'));
        await settle();
        expect(workNotice).toMatchObject({ text: 'Dismissed “five”', undo: true, error: '' });
        expect(workHidden.ids).toEqual(['t5']);
    });
});
