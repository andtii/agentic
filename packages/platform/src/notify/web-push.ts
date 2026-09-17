/**
 * Web Push channel (RFC 8030) with VAPID (RFC 8292) signed through WebCrypto,
 * so it runs on Workers, Node and browsers alike. v1 sends a *contentless*
 * push — no RFC 8291 `aes128gcm` payload — so the service worker treats a
 * push event as "the inbox changed" and re-reads `Inbox.list`. The gap and
 * the follow-up are in architecture §9.
 */

import { fromBase64Url, toBase64Url, utf8ToBase64Url } from './encoding.js';
import type { DeliveryResult, DeliveryTarget, InboxNotification, NotificationChannel } from './types.js';

export interface VapidKeys {
    /** base64url, 65-byte uncompressed P-256 point — what the browser gets as `applicationServerKey`. */
    readonly publicKey: string;
    /** base64url, 32-byte P-256 scalar. Never leaves the server. */
    readonly privateKey: string;
    /** `mailto:` or `https:` contact the push service may use (RFC 8292 §2.1). */
    readonly subject: string;
}

export interface WebPushOptions {
    /** Defaults to the global `fetch`; tests hand in a fake. */
    readonly fetch?: typeof fetch;
    /** Without keys the request is unsigned — most push services refuse it; see architecture §9. */
    readonly vapid?: VapidKeys;
    /** How long the push service keeps an undelivered message, seconds. Default one day. */
    readonly ttlSeconds?: number;
    readonly now?: () => number;
}

export const WEB_PUSH_CHANNEL = 'web-push';

/** VAPID tokens are valid at most 24 h; twelve leaves room for clock skew. */
const TOKEN_LIFETIME_S = 12 * 60 * 60;

export function webPushChannel(options: WebPushOptions = {}): NotificationChannel {
    const doFetch = options.fetch ?? globalThis.fetch;
    const ttl = String(options.ttlSeconds ?? 86_400);
    const now = options.now ?? Date.now;
    const signer = options.vapid ? vapidSigner(options.vapid) : null;

    return {
        id: WEB_PUSH_CHANNEL,
        async deliver(notification: InboxNotification, target: DeliveryTarget): Promise<DeliveryResult> {
            if (target.subscriptions.length === 0) return { ok: true };
            const expired: string[] = [];
            const failures: string[] = [];
            await Promise.all(
                target.subscriptions.map(async (sub) => {
                    const headers: Record<string, string> = {
                        TTL: ttl,
                        'Content-Length': '0',
                        Urgency: notification.kind === 'task-done' ? 'normal' : 'high',
                        Topic: notification.kind
                    };
                    try {
                        if (signer) headers.Authorization = await signer.authorization(new URL(sub.endpoint).origin, now());
                        const res = await doFetch(sub.endpoint, { method: 'POST', headers });
                        if (res.status === 404 || res.status === 410) expired.push(sub.endpoint);
                        else if (!res.ok) failures.push(`${sub.endpoint}: HTTP ${res.status}`);
                    } catch (error) {
                        failures.push(`${sub.endpoint}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                })
            );
            return {
                ok: failures.length === 0,
                ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
                ...(expired.length > 0 ? { expired } : {})
            };
        }
    };
}

export interface VapidSigner {
    /** The `Authorization` header value for one push-service origin (RFC 8292 §3). */
    authorization(audience: string, nowMs: number): Promise<string>;
}

/** ES256 over WebCrypto. The key import is lazy and memoised; a bad key fails the first delivery, not module load. */
export function vapidSigner(keys: VapidKeys): VapidSigner {
    let key: Promise<CryptoKey> | undefined;
    const importKey = (): Promise<CryptoKey> => {
        key ??= (async () => {
            const point = fromBase64Url(keys.publicKey);
            if (point.length !== 65 || point[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
            const jwk: JsonWebKey = {
                kty: 'EC',
                crv: 'P-256',
                x: toBase64Url(point.slice(1, 33)),
                y: toBase64Url(point.slice(33, 65)),
                d: keys.privateKey
            };
            return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        })();
        return key;
    };
    return {
        async authorization(audience, nowMs) {
            const header = utf8ToBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
            const claims = utf8ToBase64Url(
                JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + TOKEN_LIFETIME_S, sub: keys.subject })
            );
            const signingInput = `${header}.${claims}`;
            // WebCrypto ECDSA emits the raw `r || s` pair, which is exactly the JWS ES256 encoding.
            const signature = await crypto.subtle.sign(
                { name: 'ECDSA', hash: 'SHA-256' },
                await importKey(),
                new TextEncoder().encode(signingInput)
            );
            return `vapid t=${signingInput}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
        }
    };
}
