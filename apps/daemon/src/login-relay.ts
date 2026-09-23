/**
 * A runtime's sign-in relayed to the web (#355, #484): the CLI's own login
 * (`claude auth login --claudeai`, `codex login --device-auth`,
 * `copilot login --device-code`, per the #483 spike) run under the
 * environment's profile with piped stdio, its stdout parsed for the one
 * thing the person must do — a URL to open (Claude, which then wants the
 * code pasted back) or a device code to enter at a URL (Codex, Copilot) —
 * and its exit as the outcome. The pasted text is written to the child's
 * stdin once and appears in no log line, no file and no error message.
 *
 * `parse*` are pure and exported for tests; `spawnLoginRelay` is the Node
 * half, bound into the daemon's `login` port by `cli.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { LoginAction, LoginError } from '@agentic/core';

/** What a relay reports, in order: the action once, `waiting`, then `done` or `failed`. */
export type LoginRelayEvent =
    | { readonly phase: 'action'; readonly action: LoginAction }
    | { readonly phase: 'waiting' }
    | { readonly phase: 'done' }
    | { readonly phase: 'failed'; readonly error: LoginError };

export interface LoginRelay {
    readonly events: AsyncIterable<LoginRelayEvent>;
    /** What the person pasted back (`login.answer`): to the child's stdin, once; ignored when nothing was expected. */
    answer(text: string): void;
    /** End it: the child and everything it started are killed, and the relay reports `failed { cancelled }`. */
    cancel(): void;
}

/** A parser reads what the CLI printed so far (ANSI stripped) and names the action once it is all there. */
export type LoginParser = (output: string) => LoginAction | null;

/** How long a relay may run before it is ended `timeout`: what a device code lasts, rounded down. */
export const LOGIN_RELAY_TIMEOUT_MS = 10 * 60_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Claude Code: `If the browser didn't open, visit: <url>` — the code comes back on stdin at `Paste code here if prompted >`. */
export const parseClaudeLogin: LoginParser = (output) => {
    const m = /visit:\s*(https?:\/\/\S+)/i.exec(output);
    return m ? { kind: 'open-url', url: m[1]!, expectsPaste: true } : null;
};

/** Codex: `1. Open this link … https://auth.openai.com/codex/device` and `2. Enter this one-time code` on the line after; polled by the CLI. */
export const parseCodexLogin: LoginParser = (output) => {
    const url = /(https?:\/\/\S+\/codex\/device\S*)/i.exec(output);
    const code = /Enter this one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/i.exec(output);
    return url && code ? { kind: 'device-code', url: url[1]!, code: code[1]!.toUpperCase(), expectsPaste: false } : null;
};

/** Copilot: `To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX`; polled by the CLI. */
export const parseCopilotLogin: LoginParser = (output) => {
    const m = /visit\s+(https?:\/\/\S+)\s+and enter code\s+([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(output);
    if (m) return { kind: 'device-code', url: m[1]!, code: m[2]!.toUpperCase(), expectsPaste: false };
    // The web flow (a loopback callback on the machine): shown as a URL to open, in case the CLI picked it anyway.
    const web = /visit:\s*(https?:\/\/\S+)/i.exec(output);
    return web ? { kind: 'open-url', url: web[1]!, expectsPaste: false } : null;
};

export interface LoginRelaySpec {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly parse: LoginParser;
    /** Default `LOGIN_RELAY_TIMEOUT_MS`. */
    readonly timeoutMs?: number;
    /** Windows: a `.cmd` shim needs a shell (`env login` starts the CLI the same way). */
    readonly platform?: NodeJS.Platform;
}

/** The last non-empty line of what the child printed on stderr, with anything the person pasted taken out. */
function reasonOf(stderr: string, stdout: string, secrets: readonly string[]): string {
    const lines = stripAnsi(stderr || stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let last = lines.at(-1) ?? 'the sign-in ended without saying why';
    for (const s of secrets) if (s) last = last.split(s).join('[redacted]');
    return last.slice(0, 500);
}

/** An argument for the `cmd.exe` line the Windows spawn goes through: quoted when it holds whitespace, a quote or a shell metacharacter (`&`, `|`, `<`, `>`, `^`). */
const quoteArg = (a: string): string => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Run the CLI's login and relay it. The events end with `done` (exit 0) or `failed` (a non-zero exit with the last
 * stderr line as the reason, `cancelled`, or `timeout`); after either the child is gone.
 */
export function spawnLoginRelay(spec: LoginRelaySpec): LoginRelay {
    const platform = spec.platform ?? process.platform;
    const queue: LoginRelayEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let stdout = '';
    let stderr = '';
    let action: LoginAction | null = null;
    const secrets: string[] = [];
    let child: ChildProcess;
    const push = (event: LoginRelayEvent): void => {
        if (ended) return;
        if (event.phase === 'done' || event.phase === 'failed') ended = true;
        queue.push(event);
        wake?.();
    };
    const end = (error?: LoginError): void => {
        if (ended) return;
        clearTimeout(timer);
        push(error ? { phase: 'failed', error } : { phase: 'done' });
    };
    const kill = (): void => {
        try {
            if (child.exitCode !== null || child.signalCode !== null) return;
            // Windows: the CLI runs under the `cmd.exe` the `.cmd` shim needs, and `kill()` ends only that wrapper —
            // the CLI would keep running with its device code (#520). `taskkill /T` ends the whole tree.
            if (platform === 'win32' && child.pid !== undefined) {
                const tree = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                tree.on('error', () => child.kill());
                return;
            }
            child.kill();
        } catch {
            // Already gone.
        }
    };
    const timer = setTimeout(() => {
        end({ code: 'timeout', message: 'the sign-in was not completed in time' });
        kill();
    }, spec.timeoutMs ?? LOGIN_RELAY_TIMEOUT_MS);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) env[k] = v;
    // No colour where a CLI honours it; what slips through is stripped anyway.
    env.NO_COLOR = '1';
    try {
        child = platform === 'win32'
            ? spawn(`"${spec.command}" ${spec.args.map(quoteArg).join(' ')}`, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
            : spawn(spec.command, [...spec.args], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
        clearTimeout(timer);
        const failed: LoginRelayEvent = { phase: 'failed', error: { code: 'failed', message: `could not start the sign-in: ${e instanceof Error ? e.message : String(e)}` } };
        return { events: (async function* () { yield failed; })(), answer: () => undefined, cancel: () => undefined };
    }
    child.on('error', (e) => {
        end({ code: 'failed', message: `could not run the sign-in: ${e.message}` });
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (action) return;
        action = spec.parse(stripAnsi(stdout));
        if (action) {
            push({ phase: 'action', action });
            push({ phase: 'waiting' });
        }
    });
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        // Copilot, Codex: the device code may come on stderr in some builds; parse both.
        if (action) return;
        action = spec.parse(stripAnsi(stdout + '\n' + stderr));
        if (action) {
            push({ phase: 'action', action });
            push({ phase: 'waiting' });
        }
    });
    child.on('close', (code) => {
        if (code === 0) end();
        else end({ code: 'failed', message: reasonOf(stderr, stdout, secrets) });
    });

    const events: AsyncIterable<LoginRelayEvent> = {
        [Symbol.asyncIterator]: async function* () {
            while (true) {
                if (queue.length === 0) {
                    if (ended) return;
                    await new Promise<void>((r) => { wake = r; });
                    wake = undefined;
                    continue;
                }
                const next = queue.shift()!;
                yield next;
                if (next.phase === 'done' || next.phase === 'failed') return;
            }
        }
    };
    return {
        events,
        answer(text) {
            if (ended || !action?.expectsPaste || !child.stdin || child.stdin.destroyed) return;
            secrets.push(text);
            child.stdin.write(`${text}\n`);
        },
        cancel() {
            end({ code: 'cancelled', message: 'the sign-in was cancelled' });
            kill();
        }
    };
}
