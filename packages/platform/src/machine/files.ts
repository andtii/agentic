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

import type { ChangeScope, ChangeSet, EnvironmentId, FsOp, FsReadResult, FsReadRev, FsResult, FsTreeResult, WorkspaceAnswer, WorkspaceSource } from '@agentic/core';

/** The two Machine calls a `machineWorkspaceSource` makes; any actor client of the Machine definition satisfies it. */
export interface MachineFilesClient {
    fsRequest(environmentId: EnvironmentId, op: FsOp): Promise<{ readonly requestId: string }>;
    fsAnswer(requestId: string): AsyncIterable<WorkspaceAnswer<FsResult>>;
}

export interface MachineWorkspaceOptions {
    /**
     * The ref a branch is compared with — `read(path, 'base')` and `changes('branch')`. Usually the project git
     * feature's `base` setting; absent, the daemon resolves the upstream, then `main`, then `master`.
     */
    readonly base?: string;
}

/**
 * `machineWorkspaceSource(actor(Machine, machineKey(ws, machineId)), environmentId, session.spec.cwd, { base })` — the
 * folder `root` on `environmentId` of that machine, read-only. Paths are relative to `root`, `/`-separated.
 */
export function machineWorkspaceSource(client: MachineFilesClient, environmentId: EnvironmentId, root: string, options: MachineWorkspaceOptions = {}): WorkspaceSource {
    const base = options.base !== undefined ? { base: options.base } : {};
    async function ask<K extends FsResult['kind']>(op: FsOp, kind: K): Promise<WorkspaceAnswer<Extract<FsResult, { kind: K }>>> {
        const { requestId } = await client.fsRequest(environmentId, op);
        for await (const answer of client.fsAnswer(requestId)) {
            if (answer.error) return { error: answer.error };
            if (answer.result.kind !== kind) return { error: { code: 'internal', message: `a ${kind} request was answered with a ${answer.result.kind} result` } };
            return { result: answer.result as Extract<FsResult, { kind: K }> };
        }
        return { error: { code: 'internal', message: `no answer to fs request ${requestId}` } };
    }
    return {
        tree: (path: string): Promise<WorkspaceAnswer<FsTreeResult>> => ask({ kind: 'tree', root, path }, 'tree'),
        read: (path: string, rev?: FsReadRev): Promise<WorkspaceAnswer<FsReadResult>> => ask({ kind: 'read', root, path, ...(rev !== undefined ? { rev } : {}), ...(rev === 'base' ? base : {}) }, 'read'),
        changes: (scope: ChangeScope): Promise<WorkspaceAnswer<ChangeSet>> => ask({ kind: 'changes', root, scope, ...base }, 'changes')
    };
}
