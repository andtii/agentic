import { signal } from 'sigx';
import { defineWebStore, forward } from '../../stores/define';

/**
 * The "New schedule" request (#145), keyed like `agent/head.ts`: the topbar's button raises it, the live
 * Schedules page's dialog answers it. A web store, one per app (#1124, `stores/define.ts`).
 */
export const useScheduleRequestStore = defineWebStore('schedule-request', () => {
    const newSchedule = signal({ open: false });
    return {
        newSchedule,
        openNewSchedule(): void { newSchedule.open = true; },
        closeNewSchedule(): void { newSchedule.open = false; }
    };
});

export const newScheduleRequest = forward(() => useScheduleRequestStore().newSchedule);
export const openNewSchedule = (): void => useScheduleRequestStore().openNewSchedule();
export const closeNewSchedule = (): void => useScheduleRequestStore().closeNewSchedule();
