/**
 * Structured, redacting logs. Every line passes through `redact` before it is
 * written: known secrets (the machine token and its secret part) and
 * anything shaped like a platform bearer token (`amt.…` / `agt.…`) are
 * replaced, so a token never reaches a log file whatever a caller passes in.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
    /** One JSON line per call. Default: stderr. */
    readonly write?: (line: string) => void;
    /** Lowest level written. Default `info`. */
    readonly level?: LogLevel;
    /** Strings that must never appear in output, read at write time (the token can arrive after the logger exists). */
    readonly secrets?: () => readonly string[];
    readonly now?: () => number;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const TOKEN_SHAPE = /\b(amt|agt)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Replace every secret (8+ chars) and every bearer-token-shaped string. */
export function redact(text: string, secrets: readonly string[] = []): string {
    let out = text;
    for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
    return out.replace(TOKEN_SHAPE, '$1.[redacted]');
}

function plain(value: unknown): unknown {
    if (value instanceof Error) return { name: value.name, message: value.message };
    return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
    const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
    const min = LEVELS[options.level ?? 'info'];
    const now = options.now ?? Date.now;
    const log =
        (level: LogLevel) =>
        (message: string, fields: LogFields = {}): void => {
            if (LEVELS[level] < min) return;
            const entry: Record<string, unknown> = { at: new Date(now()).toISOString(), level, msg: message };
            for (const [k, v] of Object.entries(fields)) entry[k] = plain(v);
            write(redact(JSON.stringify(entry), options.secrets?.() ?? []));
        };
    return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** Swallows everything. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
