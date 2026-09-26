/**
 * Where a chat opens (#929): a chat that belongs to a project opens inside it, at `/projects/<projectId>/chats/<id>`
 * (the project's menu, `Projects › <project> › Chats › <chat>` crumbs, no global list); any other chat at `/chats/<id>`.
 * Every link to a chat is built here, and a chat page that is not at its chat's address replaces itself with it.
 */

/** What a chat's address depends on: its id and the project it belongs to, when it names one. */
export interface ChatHrefTarget {
    readonly id: string;
    readonly projectId?: string | null;
}

/** Whether a project still exists; the default trusts the chat's project (a caller inside that project knows it does). */
export type ProjectExists = (projectId: string) => boolean;

const always: ProjectExists = () => true;

/** The global address of a chat: `/chats/<id>`. */
export const globalChatHref = (id: string): string => `/chats/${encodeURIComponent(id)}`;

/** The address of a chat inside a project: `/projects/<projectId>/chats/<id>`. */
export const projectChatHref = (projectId: string, id: string): string => `/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(id)}`;

/** A chat's canonical address: inside its project when it has one that still exists, else `/chats/<id>`. */
export function chatHref(chat: ChatHrefTarget, exists: ProjectExists = always): string {
    const projectId = chat.projectId ?? undefined;
    return projectId && exists(projectId) ? projectChatHref(projectId, chat.id) : globalChatHref(chat.id);
}

/**
 * Where an open chat page must go, or `null` when it is already at its chat's address: `path` is the page's path,
 * `chat` the chat as read (its project may have changed since the link was built — a move, #929).
 */
export function chatRedirect(path: string, chat: ChatHrefTarget, exists: ProjectExists = always): string | null {
    const to = chatHref(chat, exists);
    return samePath(path, to) ? null : to;
}

const decoded = (path: string): string => {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
};

const samePath = (a: string, b: string): boolean => decoded(a).replace(/\/+$/, '') === decoded(b).replace(/\/+$/, '');
