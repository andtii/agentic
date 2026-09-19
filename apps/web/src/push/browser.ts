/**
 * Web Push in the browser (#244): the service worker at `/sw.js`, this
 * browser's subscription, and a VAPID key pair made with WebCrypto. Every
 * entry point is guarded: without `serviceWorker`, `PushManager` or
 * `Notification` (SSR, an old browser, an insecure origin) it does nothing and
 * says so through `pushSupport()`.
 *
 * Nothing here imports `@agentic/platform`: the base64url helpers are local, so
 * the platform stays out of the client bundle.
 */

/** Where the service worker is served from (`apps/web/public/sw.js` → the assets root, scope `/`). */
export const SERVICE_WORKER_URL = '/sw.js';

/** A subscription as the Inbox stores it (`Inbox.subscribe`). */
export interface BrowserSubscription {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
    readonly label?: string;
}

export type PushSupport = 'supported' | 'unsupported' | 'insecure';

/** Whether this browser can take push at all — `unsupported` on the server and in browsers without the APIs. */
export function pushSupport(g: typeof globalThis = globalThis): PushSupport {
    const nav = (g as { navigator?: Navigator }).navigator;
    if (!nav || !('serviceWorker' in nav) || !('PushManager' in g) || !('Notification' in g)) return 'unsupported';
    if ((g as { isSecureContext?: boolean }).isSecureContext === false) return 'insecure';
    return 'supported';
}

export function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * A fresh VAPID key pair (RFC 8292): the public key as the 65-byte uncompressed
 * P-256 point browsers take as `applicationServerKey`, the private key as the
 * 32-byte scalar `vapidSigner` imports. Both base64url. The caller hands the
 * private key straight to `Registry.setSecret` and keeps no copy.
 */
export async function generateVapidKeys(subtle: SubtleCrypto = crypto.subtle): Promise<{ publicKey: string; privateKey: string }> {
    const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const jwk = await subtle.exportKey('jwk', pair.privateKey);
    if (!jwk.d) throw new Error('the browser did not export the private key');
    return { publicKey: toBase64Url(raw), privateKey: jwk.d };
}

/** "Chrome on Windows" — how Settings tells one subscribed browser from another. */
export function deviceLabel(userAgent: string): string {
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'A browser';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
}

async function registration(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    return navigator.serviceWorker.ready;
}

/** This browser's push endpoint, or `null` when it is not subscribed (or cannot be). Never prompts. */
export async function currentEndpoint(): Promise<string | null> {
    if (pushSupport() !== 'supported') return null;
    const reg = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

/**
 * Ask for permission and subscribe this browser with the workspace's public key.
 * A subscription made with another key is replaced — the push services refuse
 * a push signed by a key the browser did not subscribe with.
 */
export async function subscribeBrowser(publicKey: string): Promise<BrowserSubscription> {
    if (pushSupport() !== 'supported') throw new Error('this browser cannot take push notifications');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'notifications are blocked for this site in the browser settings' : 'notification permission was not given');
    const reg = await registration();
    const key = fromBase64Url(publicKey);
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
        const held = existing.options.applicationServerKey;
        const same = held !== null && held !== undefined && toBase64Url(new Uint8Array(held)) === publicKey;
        if (same) return toRecord(existing);
        await existing.unsubscribe();
    }
    return toRecord(await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
}

/** Drop this browser's subscription; answers the endpoint it had, so the Inbox can forget it too. */
export async function unsubscribeBrowser(): Promise<string | null> {
    if (pushSupport() !== 'supported') return null;
    const reg = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return null;
    await sub.unsubscribe();
    return sub.endpoint;
}

function toRecord(sub: PushSubscription): BrowserSubscription {
    const json = sub.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) throw new Error('the browser returned an incomplete push subscription');
    return { endpoint: json.endpoint, keys: { p256dh, auth }, label: deviceLabel(navigator.userAgent) };
}
