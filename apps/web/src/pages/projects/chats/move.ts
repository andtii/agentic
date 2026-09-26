/**
 * A chat's move between projects (#947): `Chat.setProject` asks the project the chat leaves to release it first
 * (#936) and refuses the move with a 409 naming why (a feature hook threw or timed out — Git: a dirty worktree);
 * `{ force: true }` moves anyway. Pure over an injected `setProject`, so the page and its tests share it.
 */

/** What a move takes besides the chats: `force` moves even when the project being left refused to release them. */
export interface MoveOptions {
    readonly force?: boolean;
}

/** A move `Chat.setProject` refused (409): `chatIds` are the chats not moved yet (the refused one first), `reason` why. */
export class MoveRefused extends Error {
    readonly chatIds: readonly string[];
    readonly reason: string;
    constructor(chatIds: readonly string[], reason: string) {
        super(reason);
        this.name = 'MoveRefused';
        this.chatIds = chatIds;
        this.reason = reason;
    }
}

const PREFIX = /^Chat\.setProject:\s*/;
const HINT = /\.?\s*Move anyway with \{ force: true \}\.?\s*$/;

/** Why `Chat.setProject` refused the move, readable (its prefix and the API hint dropped); `null` when `e` is no refusal. */
export function refusalOf(e: unknown): string | null {
    if (typeof e !== 'object' || e === null || (e as { status?: unknown }).status !== 409) return null;
    const message = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? '');
    const reason = message.replace(PREFIX, '').replace(HINT, '').trim().replace(/\.+$/, '');
    return reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : 'The project this chat is in could not release it.';
}

/**
 * Moves `chatIds` one by one with `setProject`, calling `onMoved` after each. A refusal stops the loop and throws
 * `MoveRefused` with the chats left (so "Move anyway" retries just those with `force`); any other error is rethrown.
 */
export async function moveChats(
    chatIds: readonly string[],
    setProject: (chatId: string, options?: MoveOptions) => Promise<unknown>,
    onMoved: (chatId: string) => void,
    options?: MoveOptions
): Promise<void> {
    for (let i = 0; i < chatIds.length; i++) {
        const id = chatIds[i]!;
        try {
            await setProject(id, options?.force ? { force: true } : undefined);
        } catch (e) {
            const reason = refusalOf(e);
            if (reason !== null) throw new MoveRefused(chatIds.slice(i), reason);
            throw e;
        }
        onMoved(id);
    }
}
