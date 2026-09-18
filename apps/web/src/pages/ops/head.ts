import { signal } from 'sigx';

/**
 * The "New schedule" request (#145), keyed like `agent/head.ts`: the topbar's
 * button raises it, the live Schedules page's dialog answers it.
 */
export const newScheduleRequest = signal({ open: false });
export const openNewSchedule = (): void => { newScheduleRequest.open = true; };
export const closeNewSchedule = (): void => { newScheduleRequest.open = false; };
