/**
 * The consent screen — a minimal, self-contained HTML response for now (the
 * UI track can restyle it; the form contract is the stable part): a POST
 * back to the authorization endpoint with the sealed transaction and a
 * `decision`. No script, no external assets, every value escaped.
 */
import type { Scope } from '@agentic/core';

export interface ConsentView {
    readonly clientName: string;
    readonly clientUri?: string;
    readonly scopes: readonly Scope[];
    /** The sealed transaction the form posts back. */
    readonly txn: string;
    /** The authorization endpoint (form action). */
    readonly action: string;
    readonly userId: string;
}

const SCOPE_TEXT: Readonly<Record<Scope, string>> = {
    machines: 'See your machines and whether they are online',
    environments: 'See the execution environments each machine reports',
    agents: 'List your agents and read their configuration',
    sessions: 'Open, prompt, answer and cancel agent sessions, and read their events',
    tasks: 'Create, inspect and cancel tasks',
    chats: 'Post into and read your chats',
    memory: 'Search and add to agent memory',
    schedules: 'Create schedules',
    usage: "See how close each account is to its provider's usage limits",
    projects: 'List your projects and set the project a chat belongs to'
};

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderConsent(view: ConsentView): string {
    const name = escapeHtml(view.clientName);
    const client = view.clientUri ? `<a href="${escapeHtml(view.clientUri)}" rel="noopener noreferrer">${name}</a>` : `<strong>${name}</strong>`;
    // Every requested scope is a checkbox, ticked: the user may grant fewer than the client asked for (RFC 6749 §3.3).
    const items = view.scopes.map((s) => `<li><label><input type="checkbox" name="scope" value="${s}" checked> <code>${s}</code> — ${escapeHtml(SCOPE_TEXT[s])}</label></li>`).join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Authorize ${name}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#0f1115;color:#e6e6e6}
main{max-width:480px;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 8px}
ul{padding-left:20px;list-style:none}li{margin:6px 0}
code{background:#1c2029;padding:1px 6px;border-radius:4px}
.actions{display:flex;gap:12px;margin-top:24px}
button{font:inherit;padding:10px 18px;border-radius:6px;border:1px solid #3a4150;background:#1c2029;color:inherit;cursor:pointer}
button[value=allow]{background:#2f6df6;border-color:#2f6df6;color:#fff}
p.who{color:#9aa3b2;font-size:.9rem}
</style>
</head>
<body>
<main>
<h1>Allow ${client} to use your workspace?</h1>
<p class="who">Signed in as <code>${escapeHtml(view.userId)}</code>. The client will act in your name with these permissions:</p>
<p class="who">Untick a permission to grant less than the client asked for.</p>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="txn" value="${escapeHtml(view.txn)}">
<input type="hidden" name="consent" value="scoped">
<ul>${items}</ul>
<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow">Allow</button>
</div>
</form>
</main>
</body>
</html>
`;
}

/** A plain error page for requests that must not be redirected (unknown client, bad redirect URI). */
export function renderError(title: string, detail: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#0f1115;color:#e6e6e6}main{max-width:480px;margin:0 auto}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>
`;
}
