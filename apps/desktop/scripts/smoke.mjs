#!/usr/bin/env node
// A WebDriver smoke run of the built shell (#848), through tauri-driver — Linux (WebKitGTK) and
// Windows (WebView2) only; tauri-driver has no macOS support. On a fresh profile the app must start
// and show its own connect page with the server form, and reject a plain-http remote server.
//
//   tauri-driver &   # WebKitWebDriver / msedgedriver on PATH
//   node scripts/smoke.mjs <path to the built binary>

const DRIVER = process.env.TAURI_DRIVER_URL ?? 'http://127.0.0.1:4444';
const app = process.argv[2];
if (!app) {
    console.error('usage: smoke.mjs <app binary>');
    process.exit(2);
}

async function wd(method, path, body) {
    const res = await fetch(`${DRIVER}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json.value;
}

async function waitFor(check, what, ms = 30000) {
    const until = Date.now() + ms;
    let last;
    while (Date.now() < until) {
        try {
            const v = await check();
            if (v) return v;
        } catch (e) {
            last = e;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecc';
/** An element reference's id: the W3C key, or the legacy `ELEMENT` some drivers (WebKitWebDriver) still answer with. */
const idOf = (el) => el?.[ELEMENT] ?? el?.ELEMENT ?? Object.values(el ?? {})[0];

await waitFor(() => fetch(`${DRIVER}/status`).then((r) => r.ok), 'tauri-driver');
const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } });
const id = session.sessionId;
const s = (path) => `/session/${id}${path}`;
try {
    const form = await waitFor(() => wd('POST', s('/element'), { using: 'css selector', value: '#setup' }), 'the connect page');
    await waitFor(() => wd('GET', s(`/element/${idOf(form)}/displayed`)), 'the server form to show');
    console.log('connect page: server form shown');

    const input = await wd('POST', s('/element'), { using: 'css selector', value: '#url' });
    await wd('POST', s(`/element/${idOf(input)}/value`), { text: 'http://agentic.example' });
    const submit = await wd('POST', s('/element'), { using: 'css selector', value: '#setup button[type=submit]' });
    await wd('POST', s(`/element/${idOf(submit)}/click`), {});
    const error = await waitFor(async () => {
        const el = await wd('POST', s('/element'), { using: 'css selector', value: '#error' });
        const text = await wd('GET', s(`/element/${idOf(el)}/text`));
        return text || null;
    }, 'the address error');
    if (!/https/.test(error)) throw new Error(`unexpected error text: ${error}`);
    console.log(`plain http refused: ${error}`);
} finally {
    await wd('DELETE', s('')).catch(() => {});
}
console.log('smoke: ok');
