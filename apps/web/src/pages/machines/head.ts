import { signal } from 'sigx';
import { defineWebStore, forward } from '../../stores/define';
import type { OpsMachine } from '../../mock/ops';

/**
 * What the live machine page tells the topbar (#144), keyed by machine id like `agent/head.ts`: the breadcrumb
 * label and the app bar's sub-line come from the Machine actor, which only the page reads. A web store, one per
 * app (#1124, `stores/define.ts`).
 */
export const useMachineHeadStore = defineWebStore('machine-head', () => ({
    head: signal<{ value: OpsMachine | null }>({ value: null })
}));

export const machineHead = forward(() => useMachineHeadStore().head);
