/**
 * What the session's Transcript, Changes and Files views share (#564): the
 * session's folder as a `WorkspaceSource` (the pages never name a daemon, a
 * machine or a mock), which views the folder offers, where its machine
 * stands, and the seams the chat hooks (#565) plug into. `useSessionChanges`
 * loads one `ChangeSet` — live from the source, or the Machine's last
 * snapshot while the machine is offline.
 */
import { signal, watch, type JSXElement } from 'sigx';
import type { ChangeScope, ChangeSet, FsError, FsWorktreesResult, WorkspaceAnswer, WorkspaceSource } from '@agentic/core';
import type { DiffMode, LineRef } from '@agentic/ui';

/** A question about one line of a diff (#565 posts it to the session's chat with the hunk attached). */
export interface LineQuestion {
    /** Relative to the session's folder. */
    readonly path: string;
    readonly ref: LineRef;
    readonly text: string;
    /** The unified hunk around the line (`hunkAt`). */
    readonly hunk: string;
    readonly scope: ChangeScope;
}

/** The last changes a machine answered, kept for while it is offline. */
export interface ChangesSnapshot {
    readonly at: number;
    readonly result: ChangeSet;
}

export interface SessionFiles {
    readonly sessionId: string;
    /** The folder, for display (`~/Dev/agentic/branches/47-mobile-drawer`). */
    readonly root: string;
    /** No folder, or a host without the `files` feature: only the Transcript shows (an API agent). */
    readonly files: boolean;
    /** The folder is under version control: Changes shows. `undefined` until a `changes` answer says. */
    readonly vcs?: boolean;
    readonly source: WorkspaceSource | null;
    readonly machineName: string;
    readonly online: boolean;
    /** The machine's last `changes` answer for a scope, shown while it is offline. */
    readonly snapshot?: (scope: ChangeScope) => Promise<ChangesSnapshot | null>;
    /** The chat the session belongs to — the composer's "Posts to" line names it. */
    readonly chat?: { readonly id: string; readonly title: string };
    /** Times as the workspace reads them (`14:06`). */
    readonly time?: (ms: number) => string;
    /** #565: ask the session's agent about a line. Absent, line numbers are not buttons. */
    readonly ask?: (question: LineQuestion) => Promise<void>;
    /** #565: insert `@file:path` into the chat's composer. Absent, no "Mention in chat". */
    readonly mention?: (path: string) => void;
    /** #565: what goes before "copy path" in a file's header ("Edited by <tile> Edit at 14:09"). */
    readonly fileActions?: (path: string) => JSXElement | null;
    /**
     * #622: the worktrees of the session folder's repository, the session's own marked `current` — what the views may
     * switch to for a look. Absent (a daemon without the `worktrees` feature, no folder), no switcher.
     */
    readonly worktrees?: () => Promise<WorkspaceAnswer<FsWorktreesResult>>;
    /** #622: the same views over another worktree's folder. The session itself stays in its own folder (EXE-12). */
    readonly at?: (root: string) => SessionFiles;
    /** #622: set on the files `at` made: the session's own folder, which `root` is not. */
    readonly sessionRoot?: string;
}

/**
 * The files a view shows for the `?root=` query (#622): the session's own, or — when the query names another folder
 * and the files can move — the same views over that worktree.
 */
export function filesAtRoot(files: SessionFiles, root: string | undefined): SessionFiles {
    return root && files.at && root !== files.root ? files.at(root) : files;
}

/** The `?root=` a view keeps in its links: the worktree it shows, when that is not the session's own folder (#622). */
export const rootQuery = (files: Pick<SessionFiles, 'root' | 'sessionRoot'>): string | undefined => (files.sessionRoot !== undefined ? files.root : undefined);

export type SessionView = 'transcript' | 'changes' | 'files';

/**
 * `/sessions/:id/changes` with its query: the file, the scope and the view (unified is the default and left out), and
 * the worktree shown when it is not the session's own (#622).
 */
export function changesHref(id: string, q: { file?: string; scope?: ChangeScope; view?: DiffMode; root?: string } = {}): string {
    const params = new URLSearchParams();
    if (q.root) params.set('root', q.root);
    if (q.file) params.set('file', q.file);
    if (q.scope) params.set('scope', q.scope);
    if (q.view && q.view !== 'unified') params.set('view', q.view);
    const s = params.toString();
    return `/sessions/${encodeURIComponent(id)}/changes${s ? `?${s}` : ''}`;
}

/** `/sessions/:id/files` at `path`, in another worktree than the session's own when `root` says (#622). */
export function filesHref(id: string, path?: string, root?: string): string {
    const q = [...(root ? [`root=${encodeURIComponent(root)}`] : []), ...(path ? [`path=${encodeURIComponent(path)}`] : [])].join('&');
    return `/sessions/${encodeURIComponent(id)}/files${q ? `?${q}` : ''}`;
}

export const transcriptHref = (id: string): string => `/sessions/${encodeURIComponent(id)}`;

/** A query value as one string. */
export const queryOf = (v: unknown): string | undefined => (Array.isArray(v) ? queryOf(v[0]) : typeof v === 'string' && v !== '' ? v : undefined);

/** `C:\Dev\agentic\branches\x` → `~/Dev/agentic/branches/x`-ish display: forward slashes, the drive kept. */
export const displayRoot = (root: string): string => root.replace(/\\/g, '/');

/**
 * `path` relative to the session's folder `root`, `/`-separated (#565): a tool call names files absolute
 * (`C:\Dev\app\src\a.ts`), the views and the `WorkspaceSource` by their place in the folder (`src/a.ts`). A path
 * already relative comes back as it is; one outside the folder is `undefined`. Windows paths (a drive or a
 * backslash) compare case-insensitively.
 */
export function relativeToRoot(root: string, path: string): string | undefined {
    const slash = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '');
    const p = slash(path);
    const absolute = p.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(p);
    if (!absolute) return p.replace(/^\.\//, '');
    const r = slash(root);
    if (!r) return undefined;
    const windows = /^[A-Za-z]:/.test(r) || root.includes('\\');
    const fold = (s: string): string => (windows ? s.toLowerCase() : s);
    if (fold(p) === fold(r)) return '';
    return fold(p).startsWith(`${fold(r)}/`) ? p.slice(r.length + 1) : undefined;
}

export interface ChangesState {
    loading: boolean;
    set?: ChangeSet;
    error?: FsError;
    /** Set when `set` is the offline snapshot: when the machine answered it. */
    snapshotAt?: number;
    /** No live answer and no snapshot: the machine is offline and nothing was ever fetched. */
    offlineEmpty?: boolean;
}

const failure = (e: unknown): FsError => ({ code: 'internal', message: e instanceof Error ? e.message : String(e) });

/**
 * One `ChangeSet` for `scope`, reloaded when the scope, the source or `version` changes. Offline (or when the call
 * throws the Machine's 503), the Machine's last snapshot stands in, with its time.
 */
export function useSessionChanges(files: () => SessionFiles | null, scope: () => ChangeScope | null, version: () => number = () => 0): ChangesState {
    const st = signal<ChangesState>({ loading: false });
    let ticket = 0;
    const load = async (f: SessionFiles, s: ChangeScope): Promise<void> => {
        const mine = ++ticket;
        st.loading = true;
        const fromSnapshot = async (): Promise<void> => {
            const snap = await f.snapshot?.(s).catch(() => null);
            if (mine !== ticket) return;
            if (snap) {
                st.set = snap.result;
                st.snapshotAt = snap.at;
                st.error = undefined;
                st.offlineEmpty = false;
            } else {
                st.set = undefined;
                st.offlineEmpty = true;
            }
        };
        try {
            if (!f.online || !f.source) {
                await fromSnapshot();
                return;
            }
            const answer = await f.source.changes(s);
            if (mine !== ticket) return;
            st.snapshotAt = undefined;
            st.offlineEmpty = false;
            if (answer.error) {
                st.error = answer.error;
                st.set = undefined;
            } else {
                st.error = undefined;
                st.set = answer.result;
            }
        } catch (e) {
            if (mine !== ticket) return;
            // A 503 from the Machine: gone offline between the read and the call.
            if (f.snapshot) await fromSnapshot();
            else {
                st.set = undefined;
                st.error = failure(e);
            }
        } finally {
            if (mine === ticket) st.loading = false;
        }
    };
    // Keyed by what identifies the folder, not the object: a live page rebuilds `SessionFiles` on every read.
    watch(
        () => {
            const f = files();
            return `${f && f.files ? `${f.sessionId}|${f.root}|${f.online}|${f.source ? 1 : 0}` : ''}#${scope() ?? ''}#${version()}`;
        },
        () => {
            const f = files();
            const s = scope();
            if (f && f.files && s) void load(f, s);
        },
        { immediate: true }
    );
    return st;
}
