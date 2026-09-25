import { signal } from 'sigx';
import type { MockChatSummary } from '../../mock/workspace';

/**
 * Archive and restore (#884, `Chat.archive` from #774): a chat list row carries
 * whether the chat is archived. The default list leaves archived chats out and
 * draws them in a collapsed "Archived" group of their own, where each row
 * offers Restore; project Chats groups them under Archived.
 */
export type ChatListRow = MockChatSummary & {
    /** `ChatSummary.archived` (#774); absent while the chat is open. */
    readonly archived?: boolean;
};

/** What the row menu and the chat's settings raise: archive (`true`) or restore (`false`) one chat. */
export interface ArchiveRequest {
    readonly id: string;
    readonly archived: boolean;
}

/**
 * The sample workspace's archive state (mock data): what the list's row menu
 * archived or restored this visit, over each chat's own flag — kept for the
 * page's lifetime like the mock page's folders.
 */
export const mockArchive = signal<{ map: Record<string, boolean> }>({ map: {} });
export const setMockArchived = (id: string, archived: boolean): void => {
    mockArchive.map = { ...mockArchive.map, [id]: archived };
};

/** The rows as mock data has them after this visit's archives and restores. */
export function withMockArchive(chats: readonly ChatListRow[], overrides: Readonly<Record<string, boolean>>): ChatListRow[] {
    return chats.map((c) => {
        const o = overrides[c.id];
        if (o === undefined || o === (c.archived ?? false)) return c;
        if (o) return { ...c, archived: true };
        const { archived: _archived, ...rest } = c;
        return rest;
    });
}

/** Open chats (the default list) and archived ones (the collapsed group), each in the order given. */
export function splitArchived<T extends Pick<ChatListRow, 'archived'>>(chats: readonly T[]): { readonly open: T[]; readonly archived: T[] } {
    const open: T[] = [];
    const archived: T[] = [];
    for (const c of chats) (c.archived ? archived : open).push(c);
    return { open, archived };
}
