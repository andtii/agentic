import { signal } from 'sigx';
import { defineWebStore, forward } from '../../stores/define';

/**
 * The agent pages' shared state (#1124: a web store, one per app — `stores/define.ts`):
 *
 * - `head` — what the live agent page tells the topbar (#35), keyed by agent id like `chat/head.ts`: the
 *   breadcrumb label and the app bar's sub-line come from the Agent actor, which only the page reads.
 * - `newAgent` — the "New agent" request: the topbar's button raises it, the live roster's dialog answers it.
 */
export const useAgentHeadStore = defineWebStore('agent-head', () => {
    const head = signal<{ value: { id: string; name: string; role: string } | null }>({ value: null });
    const newAgent = signal({ open: false });
    return {
        head,
        newAgent,
        openNewAgent(): void { newAgent.open = true; },
        closeNewAgent(): void { newAgent.open = false; }
    };
});

export const agentHead = forward(() => useAgentHeadStore().head);
export const newAgentRequest = forward(() => useAgentHeadStore().newAgent);
export const openNewAgent = (): void => useAgentHeadStore().openNewAgent();
export const closeNewAgent = (): void => useAgentHeadStore().closeNewAgent();
