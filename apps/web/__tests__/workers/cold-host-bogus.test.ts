/**
 * The manual reproduction of #182 as a test: `wrangler dev` fresh, then
 * `POST /auth/pair` with a bogus code, must answer `401 {"error":"mismatch"}`
 * on the very first request — the directory lookup is a hop, and the hop
 * needs the Worker's host, which nothing has booted yet in this isolate
 * (no mount request, no object). Before the fix: 500 text/plain
 * "no host is running".
 */
import { SELF } from 'cloudflare:test';

const ORIGIN = 'https://agentic.test';

describe('worker: a bogus POST /auth/pair as the first request of a cold isolate (#182)', () => {
    it('answers 401 JSON, not 500 "no host is running"', async () => {
        const res = await SELF.fetch(`${ORIGIN}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABC-DEF', name: 'box' }) });
        expect(res.headers.get('content-type'), await res.clone().text()).toMatch(/^application\/json/);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'mismatch' });
    });
});
