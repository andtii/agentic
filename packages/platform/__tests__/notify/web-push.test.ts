/**
 * The Web Push channel against a fake `fetch`: one POST per subscription,
 * VAPID `Authorization` that verifies under the public key, expired
 * endpoints reported rather than retried, failures reported rather than
 * thrown (issue #29 acceptance).
 */
import { fromBase64Url, toBase64Url, vapidSigner, webPushChannel, type InboxNotification, type VapidKeys } from '../../src/notify/index.js';

const notification: InboxNotification = {
    id: 'n_1',
    kind: 'approval',
    title: 'Approve?',
    at: 0,
    read: false,
    deliveries: []
};
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' }, addedAt: 0 });
const target = (...endpoints: string[]) => ({ workspaceId: 'ws_a' as never, subscriptions: endpoints.map(sub) });

interface Sent {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
}

/** A push service that answers by endpoint path: `/201`, `/410`, `/500`, `/throw`. */
function fakePush(): { sent: Sent[]; fetch: typeof fetch } {
    const sent: Sent[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
        const status = url.slice(url.lastIndexOf('/') + 1);
        if (status === 'throw') throw new Error('ECONNRESET');
        return new Response(null, { status: Number(status) });
    };
    return { sent, fetch: impl as typeof fetch };
}

async function generateVapid(): Promise<VapidKeys & { verifyKey: CryptoKey }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const point = new Uint8Array(65);
    point[0] = 4;
    point.set(fromBase64Url(jwk.x!), 1);
    point.set(fromBase64Url(jwk.y!), 33);
    return { publicKey: toBase64Url(point), privateKey: jwk.d!, subject: 'mailto:ops@example.test', verifyKey: pair.publicKey };
}

describe('webPushChannel', () => {
    it('POSTs one contentless push per subscription with TTL, Urgency and Topic', async () => {
        const push = fakePush();
        const channel = webPushChannel({ fetch: push.fetch, ttlSeconds: 60 });
        const result = await channel.deliver(notification, target('https://push.example/a/201', 'https://push.example/b/201'));

        expect(result).toEqual({ ok: true });
        expect(push.sent.map((s) => s.url)).toEqual(['https://push.example/a/201', 'https://push.example/b/201']);
        for (const s of push.sent) {
            expect(s.method).toBe('POST');
            expect(s.headers.TTL).toBe('60');
            expect(s.headers['Content-Length']).toBe('0');
            expect(s.headers.Urgency).toBe('high');
            expect(s.headers.Topic).toBe('approval');
            expect(s.headers.Authorization).toBeUndefined(); // no VAPID configured
        }
    });

    it('reports expired endpoints and failures instead of throwing', async () => {
        const push = fakePush();
        const channel = webPushChannel({ fetch: push.fetch });
        const result = await channel.deliver(
            notification,
            target('https://push.example/a/201', 'https://push.example/b/410', 'https://push.example/c/500', 'https://push.example/d/throw')
        );
        expect(result.ok).toBe(false);
        expect(result.expired).toEqual(['https://push.example/b/410']);
        expect(result.error).toBe('https://push.example/c/500: HTTP 500; https://push.example/d/throw: ECONNRESET');
        expect(push.sent).toHaveLength(4);
    });

    it('is a no-op success without subscriptions', async () => {
        const push = fakePush();
        await expect(webPushChannel({ fetch: push.fetch }).deliver(notification, target())).resolves.toEqual({ ok: true });
        expect(push.sent).toEqual([]);
    });

    it('signs a VAPID ES256 token for the push-service origin that verifies under the public key', async () => {
        const vapid = await generateVapid();
        const push = fakePush();
        const now = Date.UTC(2026, 8, 17, 12, 0, 0);
        const channel = webPushChannel({ fetch: push.fetch, vapid, now: () => now });
        await channel.deliver(notification, target('https://fcm.example/send/abc/201'));

        const auth = push.sent[0]!.headers.Authorization!;
        const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
        expect(m).not.toBeNull();
        expect(m![2]).toBe(vapid.publicKey);

        const [h, c, s] = m![1]!.split('.');
        const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>;
        expect(decode(h!)).toEqual({ typ: 'JWT', alg: 'ES256' });
        expect(decode(c!)).toEqual({ aud: 'https://fcm.example', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:ops@example.test' });
        const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            vapid.verifyKey,
            fromBase64Url(s!),
            new TextEncoder().encode(`${h}.${c}`)
        );
        expect(valid).toBe(true);
    });

    it('turns a malformed VAPID key into a recorded failure, not a throw', async () => {
        const push = fakePush();
        const channel = webPushChannel({ fetch: push.fetch, vapid: { publicKey: 'AAEC', privateKey: 'AAEC', subject: 'mailto:x@y' } });
        const result = await channel.deliver(notification, target('https://push.example/a/201'));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('65-byte');
        expect(push.sent).toEqual([]);
    });
});

describe('vapidSigner', () => {
    it('imports the key once and signs per audience', async () => {
        const vapid = await generateVapid();
        const signer = vapidSigner(vapid);
        const a = await signer.authorization('https://a.example', 0);
        const b = await signer.authorization('https://b.example', 0);
        expect(a.startsWith('vapid t=')).toBe(true);
        expect(a).not.toBe(b);
    });
});
