/**
 * The quick-ask window (#849): pure rules, tested without a DOM. The last
 * agent asked is remembered per browser profile, so the hotkey, a line and
 * Enter is the whole round trip.
 */
import type { AgentIdentity } from '../chat/live';

export const QUICK_AGENT_KEY = 'agentic.quick.agent';

/** The agent the picker starts on: the one asked last while it still exists, else the first. */
export function initialAgent(agents: readonly Pick<AgentIdentity, 'id'>[], remembered: string | null): string {
    if (remembered && agents.some((a) => a.id === remembered)) return remembered;
    return agents[0]?.id ?? '';
}

export function canSend(agentId: string, text: string, busy: boolean): boolean {
    return !busy && !!agentId && text.trim().length > 0;
}

/** Enter sends, Shift+Enter is a new line; while an IME composes, Enter is the composition's. */
export function sendsOnKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>): boolean {
    return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}

export function readRemembered(storage: Pick<Storage, 'getItem'> | undefined): string | null {
    try {
        return storage?.getItem(QUICK_AGENT_KEY) ?? null;
    } catch {
        return null;
    }
}

export function remember(storage: Pick<Storage, 'setItem'> | undefined, agentId: string): void {
    try {
        storage?.setItem(QUICK_AGENT_KEY, agentId);
    } catch {
        // A private window or blocked storage: the picker just starts on the first agent next time.
    }
}
