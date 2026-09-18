/**
 * An archived slice of a session's event log (#198): the events a `roll`
 * dropped from the record, keyed `{sessionKey}:p{n}` so `workspaceOfKey`
 * still finds the workspace and the workspace's store lists it with the
 * session. Written once by the Session actor when its window overflows,
 * read back by `events`, `tail` and the turn-end transcript fold. Not
 * wire-callable: `authorize` denies every entry point, and a `ctx.actor`
 * hop from the Session is not one.
 *
 * A page is about `PAGE_BYTES` of JSON — well under a Durable Object value's
 * 2 MB, whatever the session's length.
 */

import { defineActor, type ActorContext } from '@sigx/actors';
import type { AgentEvent } from '@sigx/ai-agent';

export const SESSION_PAGE_TYPE = 'session-page';

export interface SessionPageState {
    events: AgentEvent[];
}

export function sessionPageKey(sessionKey: string, page: number): string {
    return `${sessionKey}:p${page}`;
}

export const SessionPage = defineActor({
    type: SESSION_PAGE_TYPE,
    authorize: () => false,
    state: (): SessionPageState => ({ events: [] }),
    methods: (ctx: ActorContext<SessionPageState>) => ({
        /** Idempotent: a page already holding this slice is left alone (a roll retried after its entry failed). */
        async store(events: readonly AgentEvent[]): Promise<void> {
            const first = events[0];
            const held = ctx.state.events[0];
            if (held && first && held.epoch === first.epoch && held.seq === first.seq && ctx.state.events.length === events.length) return;
            ctx.state.events = [...events];
            await ctx.save();
        },
        async read(): Promise<readonly AgentEvent[]> {
            return ctx.snapshot(ctx.state.events);
        }
    })
});
