/**
 * An archived slice of a chat: `PAGE` consecutive entries, keyed
 * `{chatKey}:p{n}` so `workspaceOfKey` still finds the workspace. Written
 * once by the Chat actor when its window overflows, read back by
 * `history` and `search`. Not wire-callable: `authorize` denies every entry
 * point, and a `ctx.actor` hop from Chat is not one.
 */

import { defineActor, type ActorContext } from '@sigx/actors';
import type { ChatEntry } from '@agentic/core';

export interface ChatPageState {
    /** `seq` of `entries[0]`; `-1` until stored. */
    from: number;
    entries: ChatEntry[];
}

export function pageKey(chatKey: string, page: number): string {
    return `${chatKey}:p${page}`;
}

export const ChatPage = defineActor({
    type: 'ChatPage',
    authorize: () => false,
    state: (): ChatPageState => ({ from: -1, entries: [] }),
    methods: (ctx: ActorContext<ChatPageState>) => ({
        /** Idempotent: a page already holding this slice is left alone. */
        async store(from: number, entries: readonly ChatEntry[]): Promise<void> {
            if (ctx.state.from === from && ctx.state.entries.length === entries.length) return;
            ctx.state.from = from;
            ctx.state.entries = [...entries];
            await ctx.save();
        },
        async read(): Promise<readonly ChatEntry[]> {
            return ctx.snapshot(ctx.state.entries);
        }
    })
});
