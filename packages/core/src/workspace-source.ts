/**
 * A session's folder as the Changes and Files views and the MCP tools read it (#559). Pages and tools depend on
 * `WorkspaceSource` only, never on where the files live: the web builds one over a machine's daemon (`fs.request`
 * `tree` / `read` / `changes`), tests and the mock workspace over fixtures, and a later host (a sandbox, a remote
 * checkout) plugs in by implementing the same four calls. Read-only by design — edits stay with the agent.
 */

import type { DaemonFeature } from './daemon.js';
import type { ChangeScope, ChangeSet, FsError, FsGitInfo, FsReadResult, FsReadRev, FsTreeResult } from './workdir.js';

/** An answer the way the wire gives one: the result, or the daemon's (or source's) error. */
export type WorkspaceAnswer<R> = { readonly result: R; readonly error?: undefined } | { readonly result?: undefined; readonly error: FsError };

/** Paths are relative to the session's folder, `/`-separated; `''` is the folder itself. */
export interface WorkspaceSource {
    /** One level of `path`. */
    tree(path: string): Promise<WorkspaceAnswer<FsTreeResult>>;
    /** One file at `rev` (default `working`). */
    read(path: string, rev?: FsReadRev): Promise<WorkspaceAnswer<FsReadResult>>;
    /** What changed, uncommitted or on the branch. */
    changes(scope: ChangeScope): Promise<WorkspaceAnswer<ChangeSet>>;
}

/** What a session's folder offers: `files` shows the Files view, a `vcs` also shows Changes. */
export interface WorkspaceCapabilities {
    readonly files: boolean;
    /** The VCS provider id (`git`), when the folder is under version control. */
    readonly vcs?: string;
}

/** What `workspaceCapabilities` decides from. */
export interface WorkspaceCapabilityInput {
    /**
     * The session runs in a folder on a host that can serve it — a daemon-hosted session with a `cwd`. A runtime
     * without a filesystem (`anthropic-api`) has none.
     */
    readonly folder: boolean;
    /** The host's optional features; files need `files`. Absent means the host declared none. */
    readonly features?: readonly DaemonFeature[];
    /** The folder's VCS badge as a listing reports it (git's `FsGitInfo`), when it has one. */
    readonly vcs?: FsGitInfo | { readonly vcs: string };
}

/**
 * Which views a session gets (#559): no folder or a host without the `files` feature → neither; a folder → Files;
 * a folder under version control → Changes too. VCS-neutral: a git badge reads as `git`, any other provider names
 * itself with `{ vcs }`.
 */
export function workspaceCapabilities(input: WorkspaceCapabilityInput): WorkspaceCapabilities {
    if (!input.folder || !input.features?.includes('files')) return { files: false };
    const v = input.vcs;
    if (!v) return { files: true };
    return { files: true, vcs: 'vcs' in v ? v.vcs : 'git' };
}

/**
 * A file a tool call touched (#559), as a runtime's extractor reads it out of the call's input: the path as the tool
 * gave it (usually absolute) and, when the tool names one, the first line it changed.
 */
export interface FileTouch {
    readonly path: string;
    readonly line?: number;
}

/** The URI scheme of a code reference a chat message carries in a `resource` part (`agentic-session://<sessionId>/<path>#L<n>`). */
export const SESSION_FILE_URI_SCHEME = 'agentic-session';

/** At most this many characters of embedded text (a diff hunk, a snippet) in a `resource` part. */
export const RESOURCE_TEXT_MAX_CHARS = 64 * 1024;

/** `agentic-session://<sessionId>/<path>[#L<line>]` — the path relative to the session's folder, each segment encoded. */
export function sessionFileUri(sessionId: string, path: string, line?: number): string {
    const p = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${SESSION_FILE_URI_SCHEME}://${encodeURIComponent(sessionId)}/${p}${line !== undefined ? `#L${line}` : ''}`;
}

/** The parts of a `sessionFileUri`, or `null` for any other URI. */
export function parseSessionFileUri(uri: string): { readonly sessionId: string; readonly path: string; readonly line?: number } | null {
    const m = new RegExp(`^${SESSION_FILE_URI_SCHEME}://([^/#]+)/([^#]*)(?:#L(\\d+))?$`).exec(uri);
    if (!m) return null;
    try {
        const path = m[2]!.split('/').map(decodeURIComponent).join('/');
        return m[3] !== undefined ? { sessionId: decodeURIComponent(m[1]!), path, line: Number(m[3]) } : { sessionId: decodeURIComponent(m[1]!), path };
    } catch {
        return null;
    }
}
