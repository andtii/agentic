/**
 * Running `git` (#188, #561): always through `spawn` with no shell, a timeout, `LC_ALL=C` and no terminal prompt, so
 * nothing a path or ref holds is ever interpreted by a shell and nothing waits on a credential. Stdout is kept up to
 * `maxBytes`: past it the process is killed and the run says `overflow`, with the bytes read so far and the exit code
 * the killed process had (non-zero), so no caller mistakes cut output for a success.
 */

import { spawn } from 'node:child_process';

export interface GitRun {
    readonly code: number | 'timeout' | 'missing';
    readonly stdout: Buffer;
    readonly stderr: string;
    /** Stdout went past `maxBytes`; `stdout` holds its first `maxBytes`. */
    readonly overflow: boolean;
}

export interface GitRunOptions {
    readonly timeoutMs: number;
    /** Stdout kept; past it the process is killed. Default 1 MiB. */
    readonly maxBytes?: number;
    /** Written to stdin, which is then closed. */
    readonly input?: string;
}

/** Stderr kept for messages. */
const STDERR_BYTES = 16 * 1024;

export function runGit(git: string, args: readonly string[], options: GitRunOptions): Promise<GitRun> {
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    return new Promise((done) => {
        const child = spawn(git, [...args], {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
        });
        const out: Buffer[] = [];
        let outBytes = 0;
        let err = '';
        let overflow = false;
        let timedOut = false;
        let settled = false;
        const finish = (code: GitRun['code']) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            done({ code, stdout: Buffer.concat(out, Math.min(outBytes, maxBytes)), stderr: err.trim(), overflow });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, options.timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
            if (overflow) return;
            const room = maxBytes - outBytes;
            if (chunk.length > room) {
                out.push(chunk.subarray(0, room));
                outBytes = maxBytes;
                overflow = true;
                child.kill();
                return;
            }
            out.push(chunk);
            outBytes += chunk.length;
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (err.length < STDERR_BYTES) err += chunk.toString('utf8');
        });
        child.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? 'missing' : 1));
        // Killed for overflow, a git reports no exit code: that is a failure too — `overflow` says why.
        child.on('close', (code) => finish(timedOut ? 'timeout' : (code ?? 1)));
        // A git that exits before reading stdin makes the write fail with EPIPE; the exit code says what happened.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
    });
}
