// The desktop shell's own page (docs/architecture.md §13): first-run server
// address, and "can't reach the server" with retry. Once the server answers,
// the window navigates to it and the web app takes over, sign-in included.
// A build that carries the node (#991) starts it and waits for it here; its
// claim link, while nobody owns the node, is where the window goes first.

const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const PROBE_TIMEOUT_MS = 8000;
const RETRY_MAX_MS = 30000;
/** How long the app's own node may take to listen before the page says so. */
const LOCAL_START_MS = 120000;
const LOCAL_POLL_MS = 500;

let retryTimer = 0;
let countdown = 0;

function show(id) {
    for (const s of ['connecting', 'offline', 'setup']) $(s).hidden = s !== id;
}

function setServer(origin) {
    for (const el of document.querySelectorAll('[data-server]')) el.textContent = origin ? new URL(origin).host : 'This computer';
}

/** Whether anything answers at the origin. An opaque (no-cors) response is enough. */
async function reachable(origin) {
    // AbortController + setTimeout, not AbortSignal.timeout: older system webviews lack the latter.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
        await fetch(`${origin}/`, { mode: 'no-cors', cache: 'no-store', signal: abort.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** A deep link's in-app path to open once connected (#847), taken from `get_server` once. */
let landing = '/';

/** The local node's claim link (on its own origin, checked in Rust): opened instead of `landing`, once. */
let claim = null;

/** Keep the local node's claim link, which `get_server` hands over once, whichever call gets it. */
function takeClaim(info) {
    if (info?.local?.claim) claim = info.local.claim;
}

/** Keep a link's path when it is an in-app one (`/…`, never `//host`). */
function takeLanding(path) {
    if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) landing = path;
}

async function connect(origin, attempt = 0) {
    clearTimeout(retryTimer);
    clearInterval(countdown);
    setServer(origin);
    show('connecting');
    if (await reachable(origin)) {
        // A link may have arrived while this page was already up (setup or offline): ask once more.
        try {
            const info = await invoke('get_server');
            takeLanding(info.path);
            takeClaim(info);
        } catch {
            // Keep what we have.
        }
        location.replace(claim ?? `${origin}${landing}`);
        return;
    }
    offline(origin, attempt);
}

function offline(origin, attempt, detail = '') {
    show('offline');
    $('detail').textContent = detail;
    const wait = Math.min(RETRY_MAX_MS, 2000 * 2 ** attempt);
    let left = Math.round(wait / 1000);
    $('retry-in').textContent = `Retrying in ${left} s…`;
    countdown = setInterval(() => {
        left -= 1;
        if (left > 0) $('retry-in').textContent = `Retrying in ${left} s…`;
    }, 1000);
    retryTimer = setTimeout(() => connect(origin, attempt + 1), wait);
    $('retry').onclick = () => connect(origin, 0);
    window.ononline = () => connect(origin, 0);
}

/** The app's own node: wait until it listens, then connect to it. */
async function waitLocal(started = Date.now()) {
    clearTimeout(retryTimer);
    clearInterval(countdown);
    setServer(null);
    show('connecting');
    const info = await invoke('get_server');
    takeClaim(info);
    const { local } = info;
    if (local?.status === 'ready') {
        connect(local.origin, 0);
    } else if (local?.status === 'failed' || Date.now() - started > LOCAL_START_MS) {
        localFailed(local?.error ?? 'It did not start in time.');
    } else {
        retryTimer = setTimeout(() => waitLocal(started), LOCAL_POLL_MS);
    }
}

function localFailed(error) {
    show('offline');
    $('detail').textContent = `The agentic node on this computer is not running: ${error}`;
    $('retry-in').textContent = '';
    $('retry').onclick = () => startLocal();
}

async function startLocal() {
    try {
        await invoke('use_local');
        waitLocal();
    } catch (error) {
        localFailed(String(error));
    }
}

function setup(current, canCancel, bundled = false) {
    clearTimeout(retryTimer);
    clearInterval(countdown);
    show('setup');
    const input = $('url');
    input.value = current ?? '';
    input.focus();
    $('cancel').hidden = !canCancel;
    $('cancel').onclick = () => (current ? connect(current, 0) : waitLocal());
    $('use-local').hidden = !bundled;
    $('local-hint').hidden = !bundled;
    $('use-local').onclick = () => startLocal();
    $('setup').onsubmit = async (event) => {
        event.preventDefault();
        $('error').textContent = '';
        try {
            const origin = await invoke('set_server', { url: input.value });
            connect(origin, 0);
        } catch (error) {
            $('error').textContent = String(error);
        }
    };
}

async function start() {
    const info = await invoke('get_server');
    const { server, suggested, path, local, bundled } = info;
    takeLanding(path);
    takeClaim(info);
    const change = new URLSearchParams(location.search).has('change');
    // With the local node, the server field starts empty: a remote address is the thing to type.
    const current = local ? null : server;
    $('change').onclick = () => setup(current, Boolean(server || local), bundled);
    if (change || (!server && !local)) setup(current ?? suggested, Boolean(server || local), bundled);
    else if (local) waitLocal();
    else connect(server);
}

// Whatever goes wrong before the first screen shows, show the setup form with the reason rather than a blank page.
start().catch((error) => {
    document.body.dataset.error = String(error);
    setup('', false);
    $('error').textContent = `The app could not read its settings: ${error}`;
});
