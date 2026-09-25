/**
 * Refs (#748, projects redesign #722, PRJ-11/PRJ-12): typed links on plan items, and the one text syntax shared by
 * chats, items and notes (docs/design/projects/HANDOFF.md, "Agent tools and refs"):
 *
 * `#9` item · `signalx#14` item in another project · `@lint` agent or person · `path/file.ts:38-41` file lines ·
 * `pr:604` · `4f2a9c1` commit · `chat:msg-42` · `doc:architecture.md#7` · any URL.
 *
 * A file ref pinned to a commit prints as `path/file.ts:38-41@4f2a9c1`. Pure and edge-safe.
 */

/** A plan item in this project, `#9`. */
export interface ItemRef {
    readonly kind: 'item';
    readonly n: number;
}
/** A plan item in another project, `signalx#14`; `project` is that project's slug as written. */
export interface ProjectItemRef {
    readonly kind: 'project-item';
    readonly project: string;
    readonly n: number;
}
/** An agent or a person, `@lint`; `handle` is resolved against the project's members by the reader. */
export interface MemberRef {
    readonly kind: 'member';
    readonly handle: string;
}
/** File lines `from`–`to` (1-based, inclusive). `sha` is set once the ref is pinned to a commit (`plan_ref` pins it). */
export interface FileRef {
    readonly kind: 'file';
    readonly path: string;
    readonly from: number;
    readonly to: number;
    readonly sha?: string;
}
export interface PullRef {
    readonly kind: 'pr';
    readonly n: number;
}
/** A commit by (abbreviated) hash, 7–40 lowercase hex characters. */
export interface CommitRef {
    readonly kind: 'commit';
    readonly sha: string;
}
export interface ChatMessageRef {
    readonly kind: 'chat';
    readonly messageId: string;
}
/** A doc, or one section of it: `doc:architecture.md#7`. */
export interface DocRef {
    readonly kind: 'doc';
    readonly path: string;
    readonly section?: string;
}
/** Any http(s) URL; `title` is fetched by the platform and never part of the text form. */
export interface UrlRef {
    readonly kind: 'url';
    readonly url: string;
    readonly title?: string;
}

export type Ref = ItemRef | ProjectItemRef | MemberRef | FileRef | PullRef | CommitRef | ChatMessageRef | DocRef | UrlRef;
export type RefKind = Ref['kind'];

/** One ref found in text: `start`/`end` are the UTF-16 offsets of `text` inside the input (`end` exclusive). */
export interface RefMatch {
    readonly ref: Ref;
    readonly text: string;
    readonly start: number;
    readonly end: number;
}

// A token starts at the beginning of the text or after a character that cannot be part of a token.
const LEAD = String.raw`(?<![\w./@#:-])`;
const SHA = '[0-9a-f]{7,40}';
const REF_PATTERN = new RegExp(
    LEAD +
        '(?:' +
        [
            String.raw`(?<url>https?://[^\s<>"'\x60]+)`,
            String.raw`doc:(?<docPath>[\w./-]*\w)(?:#(?<docSection>[\w-]+(?:\.[\w-]+)*))?(?![\w/-])`,
            String.raw`chat:(?<chatMsg>[\w.-]*\w)(?![\w-])`,
            String.raw`pr:(?<pr>\d+)(?![\w-])`,
            String.raw`(?<filePath>@?(?:[\w.-]+/)+[\w.-]*\w|[\w-]+(?:\.[\w-]+)+):(?<from>\d+)(?:-(?<to>\d+))?(?:@(?<fileSha>${SHA}))?(?![\w-])`,
            String.raw`(?<project>[A-Za-z0-9][\w.-]*)#(?<projectN>\d+)(?![\w-])`,
            String.raw`#(?<itemN>\d+)(?![\w-])`,
            String.raw`@(?<handle>[A-Za-z0-9](?:[\w.-]*\w)?)(?![\w/@-])`,
            String.raw`(?<sha>${SHA})(?![\w-])`,
        ].join('|') +
        ')',
    'g',
);

/** Characters a URL does not end with in prose (`see https://x.dev/a.` → the dot is the sentence's). */
const URL_TRAILING = /[.,;:!?'"*_~]+$/;

function trimUrl(url: string): string {
    let out = url.replace(URL_TRAILING, '');
    // A closing paren/bracket belongs to the URL only while it balances an opening one inside it.
    for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
        while (out.endsWith(close) && out.split(close).length > out.split(open).length) {
            out = out.slice(0, -1).replace(URL_TRAILING, '');
        }
    }
    return out;
}

/** A bare hex word is a commit only when it mixes digits and letters: `1234567` and `defaced` stay prose. */
function looksLikeSha(s: string): boolean {
    return /\d/.test(s) && /[a-f]/.test(s);
}

function toRef(g: Record<string, string | undefined>): Ref | null {
    if (g.url !== undefined) return { kind: 'url', url: g.url };
    if (g.docPath !== undefined) return g.docSection !== undefined ? { kind: 'doc', path: g.docPath, section: g.docSection } : { kind: 'doc', path: g.docPath };
    if (g.chatMsg !== undefined) return { kind: 'chat', messageId: g.chatMsg };
    if (g.pr !== undefined) return { kind: 'pr', n: Number(g.pr) };
    if (g.filePath !== undefined) {
        const from = Number(g.from);
        const to = g.to !== undefined ? Number(g.to) : from;
        if (from < 1 || to < from) return null;
        return g.fileSha !== undefined ? { kind: 'file', path: g.filePath, from, to, sha: g.fileSha } : { kind: 'file', path: g.filePath, from, to };
    }
    if (g.projectN !== undefined) return { kind: 'project-item', project: g.project!, n: Number(g.projectN) };
    if (g.itemN !== undefined) return { kind: 'item', n: Number(g.itemN) };
    if (g.handle !== undefined) return { kind: 'member', handle: g.handle };
    if (g.sha !== undefined) return looksLikeSha(g.sha) ? { kind: 'commit', sha: g.sha } : null;
    return null;
}

/** Every ref in `text`, in order. Text that only resembles a ref (`a@b.com`, `1234567`, `x#y`) is left alone. */
export function parseRefs(text: string): RefMatch[] {
    const out: RefMatch[] = [];
    for (const m of text.matchAll(REF_PATTERN)) {
        const groups = m.groups ?? {};
        let token = m[0];
        if (groups.url !== undefined) {
            token = trimUrl(token);
            if (!/^https?:\/\/[^/?#]/.test(token)) continue;
            groups.url = token;
        }
        const ref = toRef(groups);
        if (!ref) continue;
        const start = m.index;
        out.push({ ref, text: token, start, end: start + token.length });
    }
    return out;
}

/** The ref written in `text`, when `text` is exactly one ref (surrounding whitespace ignored); else null. */
export function parseRef(text: string): Ref | null {
    const trimmed = text.trim();
    const [first, ...rest] = parseRefs(trimmed);
    return first && rest.length === 0 && first.start === 0 && first.end === trimmed.length ? first.ref : null;
}

/** The canonical text form of `ref`; `parseRef(formatRef(r))` gives `r` back (bar a URL's `title`). */
export function formatRef(ref: Ref): string {
    switch (ref.kind) {
        case 'item':
            return `#${ref.n}`;
        case 'project-item':
            return `${ref.project}#${ref.n}`;
        case 'member':
            return `@${ref.handle}`;
        case 'file':
            return `${ref.path}:${ref.from === ref.to ? ref.from : `${ref.from}-${ref.to}`}${ref.sha ? `@${ref.sha}` : ''}`;
        case 'pr':
            return `pr:${ref.n}`;
        case 'commit':
            return ref.sha;
        case 'chat':
            return `chat:${ref.messageId}`;
        case 'doc':
            return ref.section !== undefined ? `doc:${ref.path}#${ref.section}` : `doc:${ref.path}`;
        case 'url':
            return ref.url;
    }
}
