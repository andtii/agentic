/**
 * `agentic-daemon pair <code> --url <platform>` (USR-04): present the
 * one-time code to `POST /auth/pair` and receive the machine token. The
 * endpoint is anonymous — the code is the proof — and answers
 * `{ token, workspaceId, machineId }` or `{ error }` with 401 / 400 / 503.
 * Anything that is not JSON (the HTML document, a proxy page) is named as
 * such — `not_json` with the status and content type — rather than parsed.
 */

export interface PairOptions {
    readonly url: string;
    readonly code: string;
    /** The machine's display name. */
    readonly name: string;
    readonly fetch?: typeof fetch;
}

export interface PairResult {
    readonly url: string;
    readonly token: string;
    readonly workspaceId: string;
    readonly machineId: string;
}

export class PairingError extends Error {
    override readonly name = 'PairingError';
    constructor(
        readonly code: string,
        message: string,
        readonly status?: number
    ) {
        super(message);
    }
}

const TOKEN = /^amt\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{43}$/;

const REASONS: Readonly<Record<string, string>> = {
    mismatch: 'the code is not valid — check it, or create a new one',
    expired: 'the code has expired — create a new one (codes last 10 minutes)',
    used: 'the code was already used — create a new one',
    malformed: 'the code is malformed — it is 6 letters and digits',
    bad_request: 'the platform refused the request',
    pairing_unavailable: 'pairing is not available on this platform'
};

/** `https://host/` → `https://host`; refuses anything but http(s). */
export function normalizePlatformUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new PairingError('bad_url', `"${url}" is not a URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new PairingError('bad_url', `the platform URL must be http(s), got ${parsed.protocol}`);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** The daemon socket for `machineId` on the platform at `url` (architecture §3). */
export function daemonSocketUrl(url: string, machineId: string): string {
    const base = new URL(normalizePlatformUrl(url));
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/_agentic/daemon/${encodeURIComponent(machineId)}`;
    return base.toString();
}

/** Codes are read aloud: ignore case, spaces and dashes. */
export function normalizePairingCode(code: string): string {
    return code.replace(/[\s-]+/g, '').toUpperCase();
}

export async function pair(options: PairOptions): Promise<PairResult> {
    const url = normalizePlatformUrl(options.url);
    const f = options.fetch ?? fetch;
    let response: Response;
    try {
        response = await f(`${url}/auth/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ code: normalizePairingCode(options.code), name: options.name })
        });
    } catch (e) {
        throw new PairingError('unreachable', `could not reach ${url}: ${(e as Error).message}`);
    }
    let body: Record<string, unknown>;
    try {
        body = (await response.json()) as Record<string, unknown>;
    } catch {
        // Not the platform's answer at all: the document (pairing not mounted, or not the Worker), a proxy page, an empty error (#180).
        const type = response.headers.get('content-type') ?? 'no content-type';
        throw new PairingError('not_json', `the platform did not answer as JSON (HTTP ${response.status}, ${type}) — is the URL the agentic Worker and is pairing mounted?`, response.status);
    }
    if (!response.ok) {
        const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
        throw new PairingError(code, REASONS[code] ?? `pairing failed (HTTP ${response.status})`, response.status);
    }
    const { token, workspaceId, machineId } = body;
    const m = typeof token === 'string' ? TOKEN.exec(token) : null;
    if (!m || m[1] !== workspaceId || m[2] !== machineId) throw new PairingError('bad_response', 'the platform answered with an unexpected token');
    return { url, token: token as string, workspaceId: workspaceId as string, machineId: machineId as string };
}
