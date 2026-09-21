/**
 * The title Claude Code gives a conversation (#460), read from its own transcript.
 *
 * The CLI titles every session on its own — a background model call after the
 * first prompt, refreshed as the work moves on — and writes the result into the
 * session's JSONL under `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl` as
 * `{"type":"ai-title","aiTitle":"…"}` rows; `/rename` writes a
 * `{"type":"custom-title","customTitle":"…"}` row that wins over them. The Agent
 * SDK reads exactly these rows (`getSessionInfo`), but resolves the config dir
 * from the calling process's `CLAUDE_CONFIG_DIR`, not the environment's — so the
 * driver reads the file itself, from the config dir it isolates the environment
 * with. Only the tail is read: the rows are re-written every turn, so the newest
 * ones are at the end, and a long transcript is never loaded whole.
 */

import { open } from 'node:fs/promises';

/** How much of the transcript's end is read: enough to hold the newest title rows of any turn. */
export const TITLE_TAIL_BYTES = 64 * 1024;

const SLUG_MAX = 200;

/**
 * The project folder Claude Code files a `cwd`'s sessions under: every character that is not ASCII
 * alphanumeric becomes `-` (`C:\Dev\app` → `C--Dev-app`). A path longer than 200 characters is cut
 * and suffixed with a hash the CLI computes; those are not reproduced here — such a path reads no title.
 */
export function projectSlug(cwd: string): string | undefined {
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return slug.length <= SLUG_MAX ? slug : undefined;
}

/** The transcript file of a session, given the config dir the CLI runs with. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | undefined {
    const slug = projectSlug(cwd);
    if (!slug) return undefined;
    return `${configDir.replace(/[\\/]+$/, '')}/projects/${slug}/${sessionId}.jsonl`;
}

const clean = (s: unknown): string | undefined => {
    if (typeof s !== 'string') return undefined;
    const t = s.replace(/\s+/g, ' ').trim();
    return t || undefined;
};

/**
 * The title in force at the end of a transcript excerpt: the newest `custom-title` row when there is
 * one (a person named it), else the newest `ai-title` row; `undefined` when the excerpt holds neither.
 * A partial first line (the excerpt starts mid-row) is skipped, as is any row that is not JSON.
 */
export function titleFromTranscriptTail(text: string): string | undefined {
    let custom: string | undefined;
    let ai: string | undefined;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line || !line.startsWith('{')) continue;
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
        let row: { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
        try {
            row = JSON.parse(line) as typeof row;
        } catch {
            continue;
        }
        if (row.type === 'custom-title') {
            custom ??= clean(row.customTitle);
            if (custom) return custom;
        } else if (row.type === 'ai-title') ai ??= clean(row.aiTitle);
    }
    return custom ?? ai;
}

export interface ReadSessionTitleInput {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
    /** The last `bytes` of the file as text, or `undefined` when there is no such file; the real file system by default. */
    readonly readTail?: (path: string, bytes: number) => Promise<string | undefined>;
}

/** The last `bytes` of `path`, decoded as UTF-8; `undefined` when the file does not exist. */
export async function readFileTail(path: string, bytes: number): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(path, 'r');
    } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return undefined;
        throw e;
    }
    try {
        const { size } = await handle.stat();
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer.toString('utf8');
    } finally {
        await handle.close();
    }
}

/**
 * The title Claude Code currently gives the session, or `undefined`: before the CLI has written one, for a
 * session it has not filed yet (the transcript appears with the first prompt), for a path the slug rule
 * does not cover, and for a transcript that cannot be read — a title is a courtesy, never a failure.
 */
export async function readSessionTitle(input: ReadSessionTitleInput): Promise<string | undefined> {
    const path = transcriptPath(input.configDir, input.cwd, input.sessionId);
    if (!path) return undefined;
    try {
        const tail = await (input.readTail ?? readFileTail)(path, TITLE_TAIL_BYTES);
        return tail === undefined ? undefined : titleFromTranscriptTail(tail);
    } catch {
        return undefined;
    }
}
