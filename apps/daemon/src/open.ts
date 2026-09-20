/**
 * `agentic-daemon open [path] [--env <id>] [--no-browser]` (#336, architecture
 * §5b): start a chat from the repo you stand in. The folder (the current
 * directory by default) is resolved against every environment's `cwdRoots`
 * with the same check `fs.request` uses, the repo's origin is read from its
 * git config, and the browser is opened on the web's `/chats/new` deep link,
 * which prefills New chat with that folder and the project whose origin
 * matches. No daemon frame is involved: the web resolves everything from
 * the query. The link is always printed first, so it works headless.
 */

import type { FsGitInfo, LocalEnvironment } from '@agentic/core';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { checkWithinRoots, gitInfo } from './fs.js';
import { normalizePlatformUrl } from './pair.js';

export interface OpenInput {
    /** The folder; default the current directory. */
    readonly path?: string;
    /** `--env`: the environment to open in, when the folder lies under several environments' roots. */
    readonly env?: string;
    readonly environments: readonly LocalEnvironment[];
    /** The platform URL from the credentials. */
    readonly url: string;
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string;
    /** The git badge reader (tests). */
    readonly gitInfo?: (dir: string) => Promise<FsGitInfo | undefined>;
}

export type OpenResolution =
    | { readonly ok: true; readonly url: string; readonly environmentId: string; readonly path: string; readonly origin?: string }
    /** 1: the folder is in no environment (or `--env` names one it is not in); 2: it is in several and `--env` must pick. */
    | { readonly ok: false; readonly exitCode: 1 | 2; readonly message: string };

const rootsLine = (env: LocalEnvironment): string => `  ${env.id} (${env.name}): ${env.cwdRoots.join(', ')}`;

/** The `/chats/new` deep link for `path` in `environmentId` on the platform at `url`. */
export function openLink(url: string, environmentId: string, path: string, origin: string | undefined): string {
    const query = `env=${encodeURIComponent(environmentId)}&path=${encodeURIComponent(path)}${origin === undefined ? '' : `&origin=${encodeURIComponent(origin)}`}`;
    return `${normalizePlatformUrl(url)}/chats/new?${query}`;
}

/**
 * Which environment `path` belongs to and the link to open. The lexical
 * path (what the user sees, as the web will show it) travels in the link;
 * the check also resolves symlinks, like every folder request.
 */
export async function resolveOpen(input: OpenInput): Promise<OpenResolution> {
    const platform = input.platform ?? process.platform;
    const path = resolve(input.cwd ?? process.cwd(), input.path ?? '.');
    if (input.environments.length === 0) return { ok: false, exitCode: 1, message: 'no environments — add one with `agentic-daemon env add --name <name> --root <dir>`' };
    const candidates = input.env === undefined ? input.environments : input.environments.filter((e) => e.id === input.env);
    if (candidates.length === 0) return { ok: false, exitCode: 1, message: `no environment "${input.env}" (there are: ${input.environments.map((e) => e.id).join(', ')})` };
    const matches: { env: LocalEnvironment; path: string; real: string }[] = [];
    let missing: string | undefined;
    for (const env of candidates) {
        const checked = await checkWithinRoots(path, env.cwdRoots, platform);
        if (checked.ok) matches.push({ env, path: checked.path, real: checked.real });
        else if (checked.code === 'not-found') missing = checked.message;
    }
    if (matches.length === 0) {
        if (missing) return { ok: false, exitCode: 1, message: missing };
        const scope = input.env === undefined ? "every environment's working roots" : `the working roots of ${input.env}`;
        return { ok: false, exitCode: 1, message: `${path} is outside ${scope}:\n${candidates.map(rootsLine).join('\n')}` };
    }
    if (matches.length > 1) {
        return { ok: false, exitCode: 2, message: `${path} is inside the roots of ${matches.length} environments — say which with --env <id>:\n${matches.map((m) => rootsLine(m.env)).join('\n')}` };
    }
    const [match] = matches as [(typeof matches)[number]];
    const origin = (await (input.gitInfo ?? gitInfo)(match.real))?.origin;
    return { ok: true, url: openLink(input.url, match.env.id, match.path, origin), environmentId: match.env.id, path: match.path, ...(origin === undefined ? {} : { origin }) };
}

/** Runs the OS opener detached; resolves once it has handed the URL over, rejects when it cannot start or exits non-zero. */
export type UrlOpener = (url: string) => Promise<void>;

/**
 * How the OS opens a URL: one `cmd` line on Windows (`start ""`: the first quoted argument is the window title, so
 * the URL is never taken for one; the URL is always quoted, since `&` between query parameters would otherwise be a
 * command separator — and a `"` inside it, which an encoded link never has, is escaped as `env-cli.ts` escapes),
 * `open` on macOS, `xdg-open` elsewhere.
 */
export function openCommand(url: string, platform: NodeJS.Platform): { readonly shell: true; readonly line: string } | { readonly shell: false; readonly command: string; readonly args: readonly string[] } {
    if (platform === 'win32') return { shell: true, line: `cmd /c start "" "${url.replace(/"/g, '\\"')}"` };
    return { shell: false, command: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** Runs `openCommand`; resolves once the opener has handed the URL over, rejects when it cannot start or exits non-zero. */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    return new Promise((done, reject) => {
        const how = openCommand(url, platform);
        const child = how.shell ? spawn(how.line, { shell: true, stdio: 'ignore', windowsHide: true }) : spawn(how.command, [...how.args], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? done() : reject(new Error(`the opener exited ${code}`))));
    });
}
