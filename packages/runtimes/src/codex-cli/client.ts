/**
 * The `codex app-server` process of one environment (#320): spawned with the profile's own
 * `CODEX_HOME` and nothing inherited that could pick another account (EXE-04/05), spoken to
 * as NDJSON JSON-RPC (the server omits `"jsonrpc"`, so the peer does not require it), and
 * initialized before anything else is sent.
 */

import { createRequire } from 'node:module';
import { createJsonRpcPeer, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { resolveExecutable, spawnAgentProcess, type ExecutableKind } from '@sigx/ai-agent-node';
import type { LocalEnvironment } from '@agentic/core';
import { profileEnv } from '../harness/env.js';
import type { InitializeParams, InitializeResponse } from './protocol.js';

/** What the driver needs of a connection — a real `JsonRpcPeer` satisfies it, a fake in tests. */
export type CodexPeer = Pick<JsonRpcPeer, 'request' | 'notify' | 'onRequest' | 'onNotification' | 'closed' | 'close'>;

/** An initialized app-server connection. */
export interface CodexConnection {
    readonly peer: CodexPeer;
    readonly info: InitializeResponse;
    /** Terminates the process (or the fake); idempotent. */
    close(): Promise<void>;
}

/** Opens one initialized app-server for an environment. */
export type CodexConnect = (env: LocalEnvironment) => Promise<CodexConnection>;

export const CODEX_CLIENT_INFO: InitializeParams['clientInfo'] = { name: 'agentic', title: 'agentic', version: '0.1.0' };

/** The parent's `OPENAI_*` and `CODEX_HOME` removed, this environment's home set (or none: `~/.codex`). */
export function codexAccountEnv(env: Pick<LocalEnvironment, 'profileDir'>, parent: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    return profileEnv(parent, { strip: [/^OPENAI_/i, /^CODEX_HOME$/i], set: { CODEX_HOME: env.profileDir } });
}

/** The `initialize` → `initialized` handshake every connection starts with. */
export async function initializeCodex(peer: CodexPeer, clientInfo: InitializeParams['clientInfo'] = CODEX_CLIENT_INFO, timeoutMs = 20_000): Promise<InitializeResponse> {
    const params: InitializeParams = { clientInfo, capabilities: { experimentalApi: false } };
    const info = await peer.request<InitializeResponse>('initialize', params, { timeoutMs });
    await peer.notify('initialized', {});
    return info;
}

export interface SpawnCodexOptions {
    /** An explicit `codex` executable (or its npm launcher script). Default: the `@openai/codex` package, else `codex` on `PATH`. */
    readonly codexPath?: string;
    /** The daemon's own environment; its account variables never reach the child. Default `process.env`. */
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    readonly clientInfo?: InitializeParams['clientInfo'];
    readonly timeoutMs?: number;
}

interface Command {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly kind?: ExecutableKind;
}

/** The launcher script of the `@openai/codex` package when it is installed beside this one. */
function packagedLauncher(): string | undefined {
    try {
        return createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    } catch {
        return undefined;
    }
}

async function codexCommand(options: SpawnCodexOptions): Promise<Command> {
    const explicit = options.codexPath ?? packagedLauncher();
    if (explicit !== undefined && /\.[cm]?js$/i.test(explicit)) return { command: process.execPath, args: [explicit] };
    const resolved = await resolveExecutable(explicit ?? 'codex');
    return { command: resolved.command, args: resolved.args, ...(resolved.env ? { env: resolved.env } : {}), kind: resolved.kind };
}

/** Spawns and initializes `codex app-server` for `env`. */
export async function spawnCodexAppServer(env: LocalEnvironment, options: SpawnCodexOptions = {}): Promise<CodexConnection> {
    const cmd = await codexCommand(options);
    const proc = spawnAgentProcess({
        command: cmd.command,
        args: [...cmd.args, 'app-server'],
        env: { ...cmd.env, ...codexAccountEnv(env, options.parentEnv ?? process.env) },
        ...(cmd.kind ? { kind: cmd.kind } : {})
    });
    await proc.spawned;
    const peer = createJsonRpcPeer({ readable: proc.readable, writable: proc.writable, requireVersion: false, cancelMethod: null });
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            await peer.close().catch(() => undefined);
            await proc.kill({ graceMs: 2_000 }).catch(() => undefined);
        })());
    void proc.exited.then(() => peer.close().catch(() => undefined));
    try {
        const info = await initializeCodex(peer, options.clientInfo, options.timeoutMs);
        return { peer, info, close };
    } catch (e) {
        await close();
        const tail = proc.stderrTail().trim().split('\n').slice(-3).join(' | ');
        throw new Error(`[codex-cli] app-server did not initialize: ${e instanceof Error ? e.message : String(e)}${tail ? ` (${tail})` : ''}`);
    }
}
