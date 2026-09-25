// The desktop shell's own page (docs/architecture.md §13): first-run server
// address, and "can't reach the server" with retry. Once the server answers,
// the window navigates to it and the web app takes over, sign-in included.

const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const PROBE_TIMEOUT_MS = 8000;
const RETRY_MAX_MS = 30000;

let retryTimer = 0;
let countdown = 0;

function show(id) {
    for (const s of ['connecting', 'offline', 'setup']) $(s).hidden = s !== id;
}

function setServer(origin) {
    for (const el of document.querySelectorAll('[data-server]')) el.textContent = new URL(origin).host;
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

/** Keep a link's path when it is an in-app one (`/…`, never `//host`). */
function takeLanding(path) {
    takeLanding(path);
}

async function connect(origin, attempt = 0) {
    clearTimeout(retryTimer);
    clearInterval(countdown);
    setServer(origin);
    show('connecting');
    if (await reachable(origin)) {
        // A link may have arrived while this page was already up (setup or offline): ask once more.
        try {
            takeLanding((await invoke('get_server')).path);
        } catch {
            // Keep what we have.
        }
        location.replace(`${origin}${landing}`);
        return;
    }
    show('offline');
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

function setup(current, canCancel) {
    clearTimeout(retryTimer);
    clearInterval(countdown);
    show('setup');
    const input = $('url');
    input.value = current ?? '';
    input.focus();
    $('cancel').hidden = !canCancel;
    $('cancel').onclick = () => connect(current, 0);
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
    const { server, suggested, path } = await invoke('get_server');
    takeLanding(path);
    const change = new URLSearchParams(location.search).has('change');
    $('change').onclick = () => setup(server, Boolean(server));
    if (!server || change) setup(server ?? suggested, Boolean(server));
    else connect(server);
}

start();
