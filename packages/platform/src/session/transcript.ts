/**
 * One slice of a session's stored transcript — its messages, whole (#397):
 * `SessionTranscriptPage` `{sessionKey}:t{n}`, about `TRANSCRIPT_PAGE_BYTES`
 * of JSON each, written by the Session's `TranscriptStore` when the runtime
 * saves a snapshot and read back by `load` — the model's own history on the
 * API path, which the record's bounded `transcript` snapshot only mirrors.
 * The record lists them (`SessionState.transcriptPages`), so a session's
 * transcript is reachable for deletion the way its event pages are. Like
 * `SessionPage`, not wire-callable: `authorize` denies every entry point.
 */

import { defineActor, type ActorContext } from '@sigx/actors';
import type { AgentMessage } from '@sigx/ai-agent';

export const SESSION_TRANSCRIPT_PAGE_TYPE = 'session-transcript-page';

export interface SessionTranscriptPageState {
    messages: AgentMessage[];
}

export function transcriptPageKey(sessionKey: string, page: number): string {
    return `${sessionKey}:t${page}`;
}

export const SessionTranscriptPage = defineActor({
    type: SESSION_TRANSCRIPT_PAGE_TYPE,
    authorize: () => false,
    state: (): SessionTranscriptPageState => ({ messages: [] }),
    methods: (ctx: ActorContext<SessionTranscriptPageState>) => ({
        async store(messages: readonly AgentMessage[]): Promise<void> {
            ctx.state.messages = [...messages];
            await ctx.save();
        },
        async read(): Promise<readonly AgentMessage[]> {
            return ctx.snapshot(ctx.state.messages);
        },
        /** Delete the page's record; idempotent. */
        async forget(): Promise<void> {
            await ctx.clearState();
        }
    })
});
