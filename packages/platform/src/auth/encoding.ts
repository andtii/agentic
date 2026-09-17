/**
 * Byte and string primitives the auth module rests on — WebCrypto and
 * `TextEncoder` only, so every file here runs unchanged on Workers, Node
 * and browsers. No Node-only globals or builtins (see the edge-safety test).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]!] = i;
// Plain base64 input (`+`, `/`) decodes too: Workers Secrets pasted from
// `openssl rand -base64 32` are the common source of a KEK.
B64_INDEX['+'] = 62;
B64_INDEX['/'] = 63;

/** RFC 4648 §5 base64url, unpadded. */
export function toBase64Url(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
    }
    if (i < bytes.length) {
        const a = bytes[i]!;
        const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
        const n = (a << 16) | (b << 8);
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
        if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    }
    return out;
}

/** Decode base64url or base64 (padding optional); `null` on any bad character. */
export function fromBase64Url(text: string): Uint8Array | null {
    const clean = text.replace(/=+$/, '');
    if (clean.length % 4 === 1) return null;
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let j = 0;
    for (let i = 0; i < clean.length; i++) {
        const v = B64_INDEX[clean[i]!];
        if (v === undefined) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[j++] = (acc >> bits) & 255;
        }
    }
    return out;
}

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return bytes;
}

/** SHA-256 of `data` (a string is UTF-8 encoded first). */
export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
    const bytes = typeof data === 'string' ? utf8(data) : data;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * Constant-time byte equality. Unequal lengths compare `false` without a
 * short-circuit on the content — a truncated forgery must not be cheaper.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}

/** Constant-time string equality (over UTF-8 bytes). */
export function timingSafeEqualText(a: string, b: string): boolean {
    return timingSafeEqual(utf8(a), utf8(b));
}
