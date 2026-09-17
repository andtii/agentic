import { signal } from 'sigx';

/**
 * What the live agent page tells the topbar (#35), keyed by agent id like
 * `chat/head.ts`: the breadcrumb label and the app bar's sub-line come from
 * the Agent actor, which only the page reads.
 */
export const agentHead = signal<{ value: { id: string; name: string; role: string } | null }>({ value: null });

/** The "New agent" request: the topbar's button raises it, the live roster's dialog answers it. */
export const newAgentRequest = signal({ open: false });
export const openNewAgent = (): void => { newAgentRequest.open = true; };
export const closeNewAgent = (): void => { newAgentRequest.open = false; };
