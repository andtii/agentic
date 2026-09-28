/**
 * The Node host's data directory (#988): `$AGENTIC_HOME`, default `~/.agentic`.
 *
 *     agentic.db   the actors (sqliteStorage, WAL sidecars beside it)
 *     files/       chat attachments and exports (`fsBucket`)
 *     .env         the host's secrets and settings, KEY=value lines (mode 0600)
 *     logs/        reserved for the host's logs
 *
 * `SESSION_SECRET` and `WORKSPACE_KEK` are generated on the first run and
 * appended to `.env`; a value already there (or in the process env, which
 * wins) is never replaced — a new `WORKSPACE_KEK` would orphan every secret
 * sealed under the old one. `APP_ORIGIN` defaults to `http://localhost:PORT`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The settings the host reads — from the process env first, then `.env`. */
export interface NodeHostEnv {
    readonly SESSION_SECRET?: string;
    readonly WORKSPACE_KEK?: string;
    readonly APP_ORIGIN?: string;
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
    readonly AGENTIC_DEV_LOGIN?: string;
}

export interface NodeHome {
    /** The data directory, absolute. */
    readonly dir: string;
    readonly database: string;
    readonly files: string;
    readonly logs: string;
    readonly envFile: string;
    readonly port: number;
    /** The merged settings: process env over `.env`, `APP_ORIGIN` defaulted. */
    readonly env: NodeHostEnv;
    /** The secrets this run generated (names only) — for the start-up log. */
    readonly generated: readonly string[];
}

export const DEFAULT_PORT = 8787;

const KEYS = ['SESSION_SECRET', 'WORKSPACE_KEK', 'APP_ORIGIN', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'AGENTIC_DEV_LOGIN'] as const;

/** `$AGENTIC_HOME`, else `~/.agentic`. */
export function homeDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
    return resolve(env.AGENTIC_HOME || join(homedir(), '.agentic'));
}

/** `KEY=value` lines; `#` comments and blank lines skipped; one pair of surrounding quotes stripped. */
export function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

const generators: Record<'SESSION_SECRET' | 'WORKSPACE_KEK', () => string> = {
    // 48 url-safe characters: ≥ 32, what `sessionSecretOf` requires.
    SESSION_SECRET: () => randomBytes(36).toString('base64url'),
    // `importWorkspaceKek`: base64 of 32 bytes.
    WORKSPACE_KEK: () => randomBytes(32).toString('base64')
};

export interface OpenHomeOptions {
    /** Default `homeDir(processEnv)`. */
    readonly dir?: string;
    /** Default `process.env`. */
    readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

/** Create the data directory (and its secrets) if missing, and read its settings. */
export function openHome(options: OpenHomeOptions = {}): NodeHome {
    const processEnv = options.processEnv ?? process.env;
    const dir = options.dir ? resolve(options.dir) : homeDir(processEnv);
    const files = join(dir, 'files');
    const logs = join(dir, 'logs');
    const envFile = join(dir, '.env');
    for (const d of [dir, files, logs]) mkdirSync(d, { recursive: true });

    const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const fromFile = parseDotEnv(existing);
    const generated: string[] = [];
    let appended = '';
    for (const name of ['SESSION_SECRET', 'WORKSPACE_KEK'] as const) {
        if (processEnv[name] || fromFile[name]) continue;
        const value = generators[name]();
        fromFile[name] = value;
        appended += `${name}=${value}\n`;
        generated.push(name);
    }
    if (appended || !existing) {
        const head = existing ? (existing.endsWith('\n') ? existing : `${existing}\n`) : '# agentic Node host settings (#988). Keep this file private.\n';
        writeFileSync(envFile, head + appended, { mode: 0o600 });
    }
    // `mode` applies only on create; tighten a file that was already there. A no-op on Windows.
    try {
        chmodSync(envFile, 0o600);
    } catch {
        // not ours to fix
    }

    const port = Number(processEnv.PORT || fromFile.PORT) || DEFAULT_PORT;
    const env: Record<string, string> = {};
    for (const key of KEYS) {
        const value = processEnv[key] || fromFile[key];
        if (value) env[key] = value;
    }
    env.APP_ORIGIN ??= `http://localhost:${port}`;
    return { dir, database: join(dir, 'agentic.db'), files, logs, envFile, port, env, generated };
}
