/**
 * A session's folder as a `WorkspaceSource` over the Machine actor (#562): each call is one `fsRequest` — the
 * `fs.request` frame goes out to the daemon — then the `fsAnswer` stream, which yields once the daemon's
 * `fs.response` has landed in a later `socketMessage` turn (or the request failed: its deadline, a disconnect, a
 * refusal at the Machine). Pages (#564) and the platform MCP server (#566) read a session's files through this and
 * nothing else, so another host of files plugs in by implementing `WorkspaceSource` itself.
 *
 * The caller owns the client — `actor(Machine, machineKey(ws, machineId))` with its own principal — so authorization
 * stays the Machine's (`sessionDriver`). A machine that is revoked, offline or has no socket, or an unknown
 * environment, makes the call throw the Machine's `ServerFnError` (403 / 503 / 404); everything the daemon or the
 * Machine answers — `outside-roots`, `not-found`, `not-a-repo`, `too-large`, `unsupported`, `timeout` — comes back as
 * the answer's `error`.
 */

import type { ChangeScope, ChangeSet, EnvironmentId, FsOp, FsReadResult, FsReadRev, FsResult, FsTreeResult, FsWorktreesResult, WorkspaceAnswer, WorkspaceSource } from '@agentic/core';

/** The two Machine calls a `machineWorkspaceSource` makes; any actor client of the Machine definition satisfies it. */
export interface MachineFilesClient {
    fsRequest(environmentId: EnvironmentId, op: FsOp): Promise<{ readonly requestId: string }>;
    fsAnswer(requestId: string): AsyncIterable<WorkspaceAnswer<FsResult>>;
}

export interface MachineWorkspaceOptions {
    /**
     * The ref a branch is compared with — `read(path, 'base')` and `changes('branch')`. Usually the project git
     * feature's `base` setting; absent, the daemon tries `main`, then `master`, then what `origin/HEAD` names.
     */
    readonly base?: string;
}

/**
 * `machineWorkspaceSource(actor(Machine, machineKey(ws, machineId)), environmentId, session.spec.cwd, { base })` — the
 * folder `root` on `environmentId` of that machine, read-only. Paths are relative to `root`, `/`-separated.
 */
/** One `fsRequest`, then the first `fsAnswer`: the answer if it is of `kind`, else an `internal` error. */
async function askMachine<K extends FsOp['kind'] & FsResult['kind']>(client: MachineFilesClient, environmentId: EnvironmentId, op: Extract<FsOp, { kind: K }>): Promise<WorkspaceAnswer<Extract<FsResult, { kind: K }>>> {
    // A request is answered by a result of its own kind: the op names it, so no caller can pair them wrongly.
    const kind: K = op.kind;
    const { requestId } = await client.fsRequest(environmentId, op);
    for await (const answer of client.fsAnswer(requestId)) {
        if (answer.error) return { error: answer.error };
        if (answer.result.kind !== kind) return { error: { code: 'internal', message: `a ${kind} request was answered with a ${answer.result.kind} result` } };
        return { result: answer.result as Extract<FsResult, { kind: K }> };
    }
    return { error: { code: 'internal', message: `no answer to fs request ${requestId}` } };
}

/**
 * The worktrees of the repository `root` is in (#622), through the same Machine calls: what a session's Files /
 * Changes may switch to for a look. A daemon without the `worktrees` feature answers `unsupported`.
 */
export function machineWorktrees(client: MachineFilesClient, environmentId: EnvironmentId, root: string): Promise<WorkspaceAnswer<FsWorktreesResult>> {
    return askMachine(client, environmentId, { kind: 'worktrees', root });
}

export function machineWorkspaceSource(client: MachineFilesClient, environmentId: EnvironmentId, root: string, options: MachineWorkspaceOptions = {}): WorkspaceSource {
    const base = options.base !== undefined ? { base: options.base } : {};
    const ask = <K extends FsOp['kind'] & FsResult['kind']>(op: Extract<FsOp, { kind: K }>) => askMachine(client, environmentId, op);
    return {
        tree: (path: string): Promise<WorkspaceAnswer<FsTreeResult>> => ask({ kind: 'tree', root, path }),
        read: (path: string, rev?: FsReadRev): Promise<WorkspaceAnswer<FsReadResult>> => ask({ kind: 'read', root, path, ...(rev !== undefined ? { rev } : {}), ...(rev === 'base' ? base : {}) }),
        changes: (scope: ChangeScope): Promise<WorkspaceAnswer<ChangeSet>> => ask({ kind: 'changes', root, scope, ...base })
    };
}
