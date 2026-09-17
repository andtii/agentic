/**
 * `WORKSPACE_KEK` — the per-deployment AES-GCM key under which stored API
 * keys are encrypted at rest (architecture §3, §9; decisions 7; EXE-10). The
 * key comes from Workers Secrets as base64 (`openssl rand -base64 32`),
 * never from code or config files.
 *
 * Sealed shape: `kek1.<base64url iv>.<base64url ciphertext+tag>`. The
 * optional `aad` (say `${workspaceId}:${slot}`) binds a ciphertext to the
 * place it is stored, so a value copied between slots fails to decrypt.
 */
import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from './encoding.js';

export const KEK_VERSION = 'kek1';
const IV_BYTES = 12;

/** Import the secret as a non-extractable AES-GCM key. Accepts 16 or 32 bytes (AES-128/256). */
export async function importWorkspaceKek(secret: string): Promise<CryptoKey> {
    const bytes = fromBase64Url(secret.trim());
    if (!bytes || (bytes.length !== 16 && bytes.length !== 32)) throw new Error('[auth] WORKSPACE_KEK must be 16 or 32 bytes, base64');
    return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A fresh 256-bit key as base64url — for `wrangler secret put WORKSPACE_KEK` and tests. */
export function generateWorkspaceKek(): string {
    return toBase64Url(randomBytes(32));
}

export async function encryptSecret(kek: CryptoKey, plaintext: string, aad?: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource };
    if (aad !== undefined) params.additionalData = utf8(aad) as BufferSource;
    const sealed = new Uint8Array(await crypto.subtle.encrypt(params, kek, utf8(plaintext) as BufferSource));
    return `${KEK_VERSION}.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

/**
 * Decrypt a value produced by `encryptSecret` under the same key and `aad`.
 * Throws on anything else — a stored secret that no longer opens is an
 * operational fault to surface, not an anonymous outcome to swallow.
 */
export async function decryptSecret(kek: CryptoKey, sealed: string, aad?: string): Promise<string> {
    const parts = sealed.split('.');
    if (parts.length !== 3 || parts[0] !== KEK_VERSION) throw new Error('[auth] not a sealed secret');
    const iv = fromBase64Url(parts[1]!);
    const body = fromBase64Url(parts[2]!);
    if (!iv || iv.length !== IV_BYTES || !body) throw new Error('[auth] not a sealed secret');
    const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource };
    if (aad !== undefined) params.additionalData = utf8(aad) as BufferSource;
    let plain: ArrayBuffer;
    try {
        plain = await crypto.subtle.decrypt(params, kek, body as BufferSource);
    } catch {
        throw new Error('[auth] sealed secret failed to decrypt (wrong key, wrong slot, or tampered)');
    }
    return fromUtf8(new Uint8Array(plain));
}
