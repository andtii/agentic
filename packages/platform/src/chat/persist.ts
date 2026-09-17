/**
 * One durable write per entry.
 *
 * `@sigx/actors` grows an O(entry) log write, `ctx.append(entry)`, folded
 * through the definition's `applyEntry` reducer (signalxjs/actors#312). The
 * pinned release does not ship it yet, so this helper takes the append when
 * the context offers one and otherwise folds the entry itself and saves —
 * the same state either way, at today's O(window) cost. Nothing else in the
 * chat folder touches persistence, so the seam moves in one place.
 */

import type { ActorContext } from '@sigx/actors';
import type { ChatEntry } from '@agentic/core';
import { applyChatEntry, type ChatState } from './state.js';

interface AppendCapable {
    append(entry: unknown): Promise<void>;
}

export async function appendEntry(ctx: ActorContext<ChatState>, entry: ChatEntry): Promise<void> {
    const append = (ctx as Partial<AppendCapable>).append;
    if (typeof append === 'function') {
        await append.call(ctx, entry);
        return;
    }
    applyChatEntry(ctx.state, entry);
    await ctx.save();
}
