/**
 * `fs.request { kind: 'run' }` (#617, #618): a project-configured command — how a project creates or prepares a
 * worktree its own way. `argv` is never joined into a shell string on POSIX: `argv[0]` is spawned with the rest as its
 * arguments. On Windows a `.cmd` shim (`pnpm`, `npm`) only starts through `cmd.exe`, so there the line is built with
 * `quoteArg`, as `env login` does. `cwd` is checked against the roots lexically and after `realpath`, and the command
 * runs in the resolved folder. Past its time the process group is killed and the answer is `timeout`; a non-zero exit
 * is still a result, with the tails of both streams.
 */

import { FS_RUN_DEFAULT_TIMEOUT_MS, FS_RUN_MAX_TIMEOUT_MS, FS_RUN_OUTPUT_TAIL, type FsError, type FsOp, type FsResult } from '@agentic/core';
import { LIMITS } from '@agentic/daemon-protocol';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { quoteArg } from './login-relay.js';
import { checkWithinRoots } from './roots.js';

export interface RunOptions {
    readonly platform: NodeJS.Platform;
    /** What the command sees. Default: the daemon's environment. */
    readonly env?: NodeJS.ProcessEnv;
}

type RunOutcome = { readonly result: FsResult } | { readonly error: FsError };

const fail = (code: FsError['code'], message: string): RunOutcome => ({ error: { code, message: message.slice(0, LIMITS.text) } });

/** Keep the last `FS_RUN_OUTPUT_TAIL` characters of a stream. */
function tail(): { push(chunk: Buffer): void; text(): string } {
    let kept = '';
    return {
        push(chunk) {
            kept = (kept + chunk.toString('utf8')).slice(-FS_RUN_OUTPUT_TAIL);
        },
        text: () => kept
    };
}

export async function runCommand(op: Extract<FsOp, { kind: 'run' }>, roots: readonly string[], options: RunOptions): Promise<RunOutcome> {
    const cwd = await checkWithinRoots(op.cwd, roots, options.platform);
    if (!cwd.ok) return fail(cwd.code, cwd.message);
    const info = await stat(cwd.real).catch(() => undefined);
    if (!info?.isDirectory()) return fail('not-found', `${op.cwd} is not a folder`);
    const timeoutMs = Math.min(op.timeoutMs ?? FS_RUN_DEFAULT_TIMEOUT_MS, FS_RUN_MAX_TIMEOUT_MS);
    const [command, ...args] = op.argv;
    if (!command) return fail('not-found', 'no command to run');
    const windows = options.platform === 'win32';
    return new Promise((done) => {
        const child = windows
            ? spawn(`"${command}" ${args.map(quoteArg).join(' ')}`, { cwd: cwd.real, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env })
            : spawn(command, args, { cwd: cwd.real, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
        const out = tail();
        const err = tail();
        let timedOut = false;
        let settled = false;
        const finish = (outcome: RunOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            done(outcome);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            // The whole group on POSIX (an installer spawns children); Windows kills the shell it started.
            if (!windows && child.pid !== undefined) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                    return;
                } catch {
                    // Already gone, or no group: fall back to the child alone.
                }
            }
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? fail('not-found', `${command} was not found on this machine`) : fail('internal', `${command} could not start: ${e.message}`)));
        child.on('close', (code) => {
            if (timedOut) return finish(fail('timeout', `${command} did not finish within ${timeoutMs} ms`));
            // cmd.exe answers a program it cannot find with 9009.
            if (windows && code === 9009) return finish(fail('not-found', `${command} was not found on this machine`));
            finish({ result: { kind: 'run', exitCode: code ?? 1, stdoutTail: out.text(), stderrTail: err.text() } });
        });
    });
}
