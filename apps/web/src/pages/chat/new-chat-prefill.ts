/**
 * The `/chats/new?env=&path=&origin=` deep link (#336, architecture §10):
 * what `agentic-daemon open` sends the browser to. Pure: the query → a
 * prefill, the project whose git feature names the same origin, and the
 * folder's name for a project created from it.
 */
import { sameOrigin, type ProjectRecord } from '@agentic/core';

/** The folder a new chat starts in, and the repo it is a checkout of when it is one. */
export interface NewChatPrefill {
    readonly environmentId: string;
    readonly path: string;
    readonly origin?: string;
}

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

const one = (value: string | readonly string[] | undefined): string | undefined => {
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === 'string' && text.trim() ? text : undefined;
};

/** The prefill in a route's query; `undefined` without `env` and `path` (a malformed link opens the plain dialog). */
export function newChatPrefillOf(query: Query): NewChatPrefill | undefined {
    const environmentId = one(query['env']);
    const path = one(query['path']);
    if (!environmentId || !path) return undefined;
    const origin = one(query['origin']);
    return { environmentId, path, ...(origin ? { origin } : {}) };
}

/** `/chats/new?project=<id>` (#929): New chat from a project's pages opens the dialog on that project. */
export function newChatProjectOf(query: Query): string | undefined {
    return one(query['project']);
}

/** The New chat link from a project's pages: the dialog opens on the project, and the chat made opens inside it. */
export const newChatInProjectHref = (projectId: string): string => `/chats/new?project=${encodeURIComponent(projectId)}`;

/** The origin a project's git feature names (`features['agentic.feature.git'].origin`, or a plain `git` entry). */
export function projectOriginOf(project: { readonly features?: ProjectRecord['features'] }): string | undefined {
    const features = project.features ?? {};
    for (const id of ['agentic.feature.git', 'git']) {
        const origin = features[id]?.['origin'];
        if (typeof origin === 'string' && origin) return origin;
    }
    return undefined;
}

/** The first project whose git feature names `origin` (core's `sameOrigin`: scheme, host case and `.git` do not matter). */
export function projectForOrigin<P extends { readonly features?: ProjectRecord['features'] }>(projects: readonly P[], origin: string | undefined): P | undefined {
    if (!origin) return undefined;
    return projects.find((p) => {
        const mine = projectOriginOf(p);
        return mine !== undefined && sameOrigin(mine, origin);
    });
}

/** The last segment of a native path, either separator: the name a project made from the folder starts with. */
export function folderNameOf(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) ?? path;
}

/** `/projects/new` prefilled from the folder (#336): the name from the folder, one folder row, the origin for the git feature. */
export function newProjectLink(prefill: NewChatPrefill): string {
    // `encodeURIComponent`, as the daemon encodes its link: the router decodes with `decodeURIComponent`, so a `+` would stay a plus.
    const pairs: [string, string][] = [['name', folderNameOf(prefill.path)], ['env', prefill.environmentId], ['path', prefill.path], ...(prefill.origin ? [['origin', prefill.origin] as [string, string]] : [])];
    return `/projects/new?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
