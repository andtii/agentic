/**
 * The local owner on a Node host (#989): claim a fresh node without email or
 * a GitHub OAuth app, then sign in with a passphrase.
 *
 *     <home>/owner.json    the `LocalOwnerRecord`: the pending claim, then the owner (mode 0600)
 *     <home>/claim-token   the one live claim token, until it is redeemed (mode 0600)
 *
 * `prepareClaim` runs at start-up: no owner yet → the live token (a fresh one
 * when there is none or it expired), whose link `main.ts` prints. The rules —
 * single use, expiry, PBKDF2 — are `@agentic/platform`'s (`auth/local-owner.ts`);
 * this file keeps the record and serves the routes:
 *
 *     GET  /auth/claim?t=…      the set-a-passphrase form, or why the link is dead
 *     POST /auth/claim          redeem: `local_owner` session + elevation, then `/`
 *     GET  /auth/local-login    the passphrase form (once an owner exists)
 *     POST /auth/local-login    session (+ elevation when asked), then `returnTo`
 *     GET  /auth/elevate        for `local_owner`: the passphrase form in elevate mode
 *                               (a GitHub session falls through to the web's route)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '@agentic/core';
import {
    checkClaim,
    elevationCookie,
    isClaimLive,
    issueClaim,
    LOCAL_OWNER_ID,
    PASSPHRASE_MIN_LENGTH,
    redeemClaim,
    safeReturnTo,
    sealElevation,
    sealSession,
    sessionCookie,
    sessionFromRequest,
    verifyLocalOwner,
    type LocalOwnerRecord
} from '@agentic/platform';

export const CLAIM_PATH = '/auth/claim';
export const LOCAL_LOGIN_PATH = '/auth/local-login';
const ELEVATE_PATH = '/auth/elevate';

/** Where the record and the live token are kept. */
export interface LocalOwnerStore {
    load(): LocalOwnerRecord;
    save(record: LocalOwnerRecord): void;
    readToken(): string | null;
    writeToken(token: string): void;
    dropToken(): void;
}

/** The record and token as files in the data directory. */
export function fileLocalOwnerStore(dir: string): LocalOwnerStore {
    const recordFile = join(dir, 'owner.json');
    const tokenFile = join(dir, 'claim-token');
    return {
        load() {
            if (!existsSync(recordFile)) return {};
            const parsed = JSON.parse(readFileSync(recordFile, 'utf8')) as unknown;
            return typeof parsed === 'object' && parsed !== null ? (parsed as LocalOwnerRecord) : {};
        },
        save(record) {
            writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        },
        readToken() {
            return existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() || null : null;
        },
        writeToken(token) {
            writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
        },
        dropToken() {
            rmSync(tokenFile, { force: true });
        }
    };
}

/** In memory (tests). */
export function memoryLocalOwnerStore(initial: LocalOwnerRecord = {}): LocalOwnerStore {
    let record = initial;
    let token: string | null = null;
    return {
        load: () => record,
        save: (next) => {
            record = next;
        },
        readToken: () => token,
        writeToken: (next) => {
            token = next;
        },
        dropToken: () => {
            token = null;
        }
    };
}

/**
 * Start-up: the live claim token when no owner exists yet — the stored one
 * while it still checks out, else a fresh one (which replaces it) — or
 * `null` once the node is claimed.
 */
export async function prepareClaim(store: LocalOwnerStore, secret: string, now: number = Date.now()): Promise<string | null> {
    const record = store.load();
    if (record.owner) {
        store.dropToken();
        return null;
    }
    const stored = store.readToken();
    if (stored && isClaimLive(record, now) && (await checkClaim(stored, record, secret, now)).ok) return stored;
    const { token, claim } = await issueClaim(secret, { now });
    store.save({ ...record, claim });
    store.writeToken(token);
    return token;
}

/** The link `main.ts` prints. */
export const claimUrl = (origin: string, token: string): string => `${origin.replace(/\/+$/, '')}${CLAIM_PATH}?t=${encodeURIComponent(token)}`;

export interface LocalOwnerRoutesOptions {
    readonly store: LocalOwnerStore;
    /** Signs the claim token and the cookies. */
    readonly secret: string;
    readonly now?: () => number;
    /** PBKDF2 iterations for a new passphrase (tests lower it). */
    readonly iterations?: number;
    /** Failed logins allowed per `LOGIN_WINDOW_MS` before 429. Default 5. */
    readonly maxFailures?: number;
}

const LOGIN_WINDOW_MS = 60_000;

export type LocalOwnerRoute = (request: Request) => Promise<Response>;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function page(title: string, body: string, status = 200): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · agentic</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e8ec; }
main { width: min(380px, calc(100vw - 32px)); display: grid; gap: 12px; padding: 24px; border: 1px solid #2a2f3a; border-radius: 12px; background: #161a22; box-sizing: border-box; }
form { display: grid; gap: 12px; }
h1 { margin: 0 0 4px; font-size: 18px; }
p { margin: 0; color: #9aa3b2; font-size: 13px; }
label { display: grid; gap: 4px; font-size: 13px; color: #9aa3b2; }
label.check { display: flex; gap: 8px; align-items: center; }
input { font: inherit; padding: 8px 10px; border: 1px solid #2a2f3a; border-radius: 8px; background: #0f1115; color: inherit; }
button { font: inherit; font-weight: 600; padding: 9px 12px; border: 0; border-radius: 8px; background: #4f8cff; color: #fff; cursor: pointer; }
[data-error] { color: #ff7b72; font-size: 13px; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

const errorLine = (error?: string): string => (error ? `<p data-error role="alert">${escapeHtml(error)}</p>` : '');

function claimForm(token: string, error?: string, status = 200): Response {
    return page(
        'Claim this node',
        `<form method="post" action="${CLAIM_PATH}" data-claim>
<h1>Claim this node</h1>
<p>You become its owner. Choose a passphrase (at least ${PASSPHRASE_MIN_LENGTH} characters) to sign in with from now on.</p>
${errorLine(error)}
<input type="hidden" name="t" value="${escapeHtml(token)}">
<label>Passphrase<input name="passphrase" type="password" autocomplete="new-password" minlength="${PASSPHRASE_MIN_LENGTH}" required></label>
<label>Repeat it<input name="confirm" type="password" autocomplete="new-password" minlength="${PASSPHRASE_MIN_LENGTH}" required></label>
<button type="submit">Claim</button>
</form>`,
        status
    );
}

const CLAIM_REFUSED: Record<string, string> = {
    invalid: 'This claim link is not valid or has expired. Restart the node to print a fresh one.',
    used: 'This claim link was already used.',
    claimed: 'This node already has an owner. Sign in with the passphrase.'
};

function claimRefused(reason: string): Response {
    const link = reason === 'claimed' ? `<p><a href="${LOCAL_LOGIN_PATH}" style="color:#4f8cff">Sign in</a></p>` : '';
    return page('Claim refused', `<h1>Cannot claim</h1><p data-error role="alert">${escapeHtml(CLAIM_REFUSED[reason] ?? reason)}</p>${link}`, 403);
}

function loginForm(fields: { returnTo: string; elevate: boolean; error?: string }, status = 200): Response {
    return page(
        'Sign in',
        `<form method="post" action="${LOCAL_LOGIN_PATH}" data-local-login>
<h1>Sign in</h1>
<p>The owner's passphrase for this node.</p>
${errorLine(fields.error)}
<input type="hidden" name="returnTo" value="${escapeHtml(fields.returnTo)}">
<label>Passphrase<input name="passphrase" type="password" autocomplete="current-password" required autofocus></label>
<label class="check"><input name="elevate" type="checkbox" value="1"${fields.elevate ? ' checked' : ''}> Elevated (may change machine security for ten minutes)</label>
<button type="submit">Sign in</button>
</form>`,
        status
    );
}

async function readForm(request: Request): Promise<FormData | null> {
    const type = request.headers.get('content-type') ?? '';
    if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return null;
    try {
        return await request.formData();
    } catch {
        return null;
    }
}

const field = (form: FormData, name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
};

/**
 * The resolver `NodeHost.fetch` asks first: the handler for `request`, or
 * `undefined` when the path is not one of these (or, for `/auth/elevate`,
 * the session is not the local owner's).
 */
export function createLocalOwnerRoutes(options: LocalOwnerRoutesOptions): (request: Request) => Promise<LocalOwnerRoute | undefined> {
    const { store, secret } = options;
    const now = options.now ?? Date.now;
    const maxFailures = options.maxFailures ?? 5;
    let failures: number[] = [];
    // Redemptions run one at a time, so two posts of one token cannot both pass the check before either saves.
    let lock: Promise<unknown> = Promise.resolve();
    const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => undefined);
        return run;
    };

    const cookiesFor = async (elevate: boolean): Promise<string[]> => {
        const at = now();
        const cookies = [sessionCookie(await sealSession({ userId: LOCAL_OWNER_ID, workspaceId: LOCAL_OWNER_ID as WorkspaceId }, secret, { now: at }))];
        if (elevate) cookies.push(elevationCookie(await sealElevation({ userId: LOCAL_OWNER_ID }, secret, { now: at })));
        return cookies;
    };
    const seeOther = (location: string, cookies: readonly string[]): Response => {
        const headers = new Headers({ location, 'cache-control': 'no-store' });
        for (const c of cookies) headers.append('set-cookie', c);
        return new Response(null, { status: 303, headers });
    };

    const claimGet: LocalOwnerRoute = async (request) => {
        const token = new URL(request.url).searchParams.get('t') ?? '';
        const verdict = await checkClaim(token, store.load(), secret, now());
        return verdict.ok ? claimForm(token) : claimRefused(verdict.reason);
    };

    const claimPost: LocalOwnerRoute = async (request) => {
        const form = await readForm(request);
        if (!form) return claimRefused('invalid');
        const token = field(form, 't');
        const passphrase = field(form, 'passphrase');
        if (passphrase !== field(form, 'confirm')) {
            const verdict = await checkClaim(token, store.load(), secret, now());
            return verdict.ok ? claimForm(token, 'The two passphrases differ.', 400) : claimRefused(verdict.reason);
        }
        return serialized(async () => {
            const result = await redeemClaim(token, passphrase, store.load(), secret, { now: now(), ...(options.iterations ? { iterations: options.iterations } : {}) });
            if (!result.ok) {
                if (result.reason === 'passphrase_short') return claimForm(token, `At least ${PASSPHRASE_MIN_LENGTH} characters.`, 400);
                if (result.reason === 'passphrase_long') return claimForm(token, 'That passphrase is too long.', 400);
                return claimRefused(result.reason);
            }
            // Spent before any cookie exists: a crash after this leaves a used token, never a reusable one.
            store.save(result.record);
            store.dropToken();
            return seeOther('/', await cookiesFor(true));
        });
    };

    const loginGet: LocalOwnerRoute = async (request) => {
        const url = new URL(request.url);
        return loginForm({ returnTo: safeReturnTo(url.searchParams.get('returnTo')), elevate: url.searchParams.get('elevate') === '1' });
    };

    const loginPost: LocalOwnerRoute = async (request) => {
        const form = await readForm(request);
        const returnTo = safeReturnTo(form ? field(form, 'returnTo') : null);
        const elevate = !!form && field(form, 'elevate') === '1';
        const at = now();
        failures = failures.filter((t) => t > at - LOGIN_WINDOW_MS);
        if (failures.length >= maxFailures) return loginForm({ returnTo, elevate, error: 'Too many attempts. Wait a minute.' }, 429);
        if (!form || !(await verifyLocalOwner(store.load(), field(form, 'passphrase')))) {
            failures.push(at);
            return loginForm({ returnTo, elevate, error: 'Wrong passphrase.' }, 401);
        }
        failures = [];
        return seeOther(returnTo, await cookiesFor(elevate));
    };

    return async (request) => {
        const { pathname, searchParams } = new URL(request.url);
        const method = request.method;
        if (pathname === CLAIM_PATH) {
            if (method === 'GET') return claimGet;
            if (method === 'POST') return claimPost;
            return undefined;
        }
        if (pathname === LOCAL_LOGIN_PATH) {
            if (!store.load().owner) return undefined;
            if (method === 'GET') return loginGet;
            if (method === 'POST') return loginPost;
            return undefined;
        }
        if (pathname === ELEVATE_PATH && method === 'GET') {
            const session = await sessionFromRequest(request, secret, now());
            if (session?.userId !== LOCAL_OWNER_ID || !store.load().owner) return undefined;
            const returnTo = safeReturnTo(searchParams.get('returnTo'));
            return async () => seeOther(`${LOCAL_LOGIN_PATH}?elevate=1&returnTo=${encodeURIComponent(returnTo)}`, []);
        }
        return undefined;
    };
}
