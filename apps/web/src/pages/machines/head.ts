import { signal } from 'sigx';
import type { OpsMachine } from '../../mock/ops';

/**
 * What the live machine page tells the topbar (#144), keyed by machine id
 * like `agent/head.ts`: the breadcrumb label and the app bar's sub-line come
 * from the Machine actor, which only the page reads.
 */
export const machineHead = signal<{ value: OpsMachine | null }>({ value: null });
