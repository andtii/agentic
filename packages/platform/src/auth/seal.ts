/**
 * `seal` / `open` — the one HMAC-SHA256 envelope every signed token here
 * uses: the session cookie, the OAuth transient cookie and the agent token.
 *
 * Wire shape: `<kind>.<base64url(json payload)>.<base64url(mac)>`, where the
 * MAC covers `<kind>.<payload>` so a token of one kind can never be replayed
 * as another. Every payload carries `exp` (epoch ms); an expired token opens
 * as `null`, exactly like a forged one — the caller only ever learns "no
 * valid token", which is the anonymous outcome, never an error.
 */
import { fromBase64Url, fromUtf8, timingSafeEqual, toBase64Url, utf8 } from './encoding.js';

export interface SealedPayload {
    /** Absolute expiry, epoch ms. */
    readonly exp: number;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key for a secret, imported once per process per secret. */
export function hmacKey(secret: string): Promise<CryptoKey> {
    if (secret.length < 16) throw new Error('[auth] secret must be at least 16 characters');
    let key = keys.get(secret);
    if (!key) {
        // A handful of secrets per process at most (rotation keeps two);
        // clear rather than grow if something rotates per call.
        if (keys.size > 8) keys.clear();
        key = crypto.subtle.importKey('raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
        keys.set(secret, key);
    }
    return key;
}

async function mac(secret: string, message: string): Promise<Uint8Array> {
    const key = await hmacKey(secret);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message) as BufferSource));
}

/** Sign `payload` under `kind`. */
export async function seal<T extends SealedPayload>(kind: string, payload: T, secret: string): Promise<string> {
    if (!/^[a-z0-9]+$/.test(kind)) throw new Error(`[auth] bad seal kind "${kind}"`);
    const body = `${kind}.${toBase64Url(utf8(JSON.stringify(payload)))}`;
    return `${body}.${toBase64Url(await mac(secret, body))}`;
}

/**
 * Verify and decode a token of `kind`. `null` for anything short of a valid,
 * unexpired signature — malformed, wrong kind, forged, truncated, expired.
 */
export async function open<T extends SealedPayload>(kind: string, token: string | null | undefined, secret: string, now: number): Promise<T | null> {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== kind) return null;
    const [, payloadB64, macB64] = parts as [string, string, string];
    const got = fromBase64Url(macB64);
    if (!got) return null;
    const want = await mac(secret, `${kind}.${payloadB64}`);
    if (!timingSafeEqual(got, want)) return null;
    const raw = fromBase64Url(payloadB64);
    if (!raw) return null;
    let payload: unknown;
    try {
        payload = JSON.parse(fromUtf8(raw));
    } catch {
        return null;
    }
    if (!isSealed(payload) || payload.exp <= now) return null;
    return payload as T;
}

function isSealed(value: unknown): value is SealedPayload {
    return typeof value === 'object' && value !== null && typeof (value as { exp?: unknown }).exp === 'number';
}
