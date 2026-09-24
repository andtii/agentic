/**
 * `@agentic/connectors` (#531) against the real Gmail spec of
 * `@aigntiq/conduit-connectors` and a fake Google (`http`): sign-in through
 * `clientFromSecrets`, operations → namespaced tools with the spec's schema
 * and hints, `execute` mapped through the spec, a `needsReauth` account as a
 * tool error, the manifest, and the edge-safety of the source.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inProcessLocks, memoryAccounts, memoryTransient, type AccountStore, type OperationSpec } from '@aigntiq/conduit';
import type { AnyTool } from '@sigx/ai';
import gmailSpec from '@aigntiq/conduit-connectors/gmail';
import { describe, expect, it } from 'vitest';

import {
    clientFromSecrets,
    conduitConnectorManifest,
    conduitTools,
    connectorClientSecretNames,
    connectorToolName,
    ConnectorNetworkError,
    ConnectorToolError,
    connectorHostAllowed,
    createConnectorEngine,
    guardHttp,
    gmailConnectorPlugin,
    operationAnnotations,
    type ConnectorEngine
} from '../src/index';

const OWNER = 'ws_1';
const REDIRECT = 'https://agentic.example/_agentic/connectors/callback';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN = 'https://oauth2.googleapis.com/token';

const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Seen {
    readonly method: string;
    readonly url: string;
    readonly auth: string | null;
    readonly body: string;
}

/** A fake Google: the token endpoint and the Gmail routes the tests call. `revoked` makes Gmail answer 401 and refresh answer `invalid_grant`. */
function fakeGoogle() {
    const seen: Seen[] = [];
    const state = { revoked: false };
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const http = async (request: Request): Promise<Response> => {
        const body = request.method === 'GET' ? '' : await request.text();
        seen.push({ method: request.method, url: request.url, auth: request.headers.get('Authorization'), body });
        const url = new URL(request.url);
        if (request.url === TOKEN) {
            const form = new URLSearchParams(body);
            if (form.get('grant_type') === 'authorization_code') {
                return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.modify' });
            }
            return state.revoked ? json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) : json({ access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' });
        }
        if (!request.url.startsWith(GMAIL)) return json({ error: { message: `no route ${request.url}` } }, 404);
        if (state.revoked || request.headers.get('Authorization') !== 'Bearer at-1') return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
        const path = url.pathname.replace('/gmail/v1/users/me', '');
        if (path === '/profile') return json({ emailAddress: 'owner@example.com' });
        if (path === '/messages' && request.method === 'GET') return json({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }] });
        if (path === '/messages/m1' && request.method === 'GET') {
            return json({
                id: 'm1',
                threadId: 't1',
                labelIds: ['INBOX', 'UNREAD'],
                snippet: 'Lunch?',
                internalDate: '1790000000000',
                payload: {
                    mimeType: 'multipart/alternative',
                    headers: [
                        { name: 'From', value: 'ada@example.com' },
                        { name: 'To', value: 'owner@example.com' },
                        { name: 'Subject', value: 'Lunch' }
                    ],
                    parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64url('Lunch on Friday?') } }]
                }
            });
        }
        if (path === '/messages/send' && request.method === 'POST') return json({ id: 'm9', threadId: 't9', labelIds: ['SENT'] });
        return json({ error: { message: 'Requested entity was not found.' } }, 404);
    };
    return { http, seen, state };
}

interface Harness {
    readonly engine: ConnectorEngine;
    readonly google: ReturnType<typeof fakeGoogle>;
    readonly accounts: AccountStore;
    connect(): Promise<string>;
}

function harness(secrets: Record<string, string | undefined> = { 'gmail-client-id': 'cid.apps.googleusercontent.com', 'gmail-client-secret': 'client-shh' }): Harness {
    const google = fakeGoogle();
    const accounts = memoryAccounts();
    const engine = createConnectorEngine({
        secret: 'a-workspace-secret-that-is-long-enough-0123456789',
        accounts,
        transient: memoryTransient(),
        locks: inProcessLocks(),
        clients: clientFromSecrets(async (name) => secrets[name], 'gmail'),
        redirectUri: REDIRECT,
        http: google.http
    });
    return {
        engine,
        google,
        accounts,
        async connect() {
            const begun = await engine.auth.begin({ connector: 'gmail', method: 'oauth', owner: OWNER });
            if (begun.type !== 'redirect') throw new Error('expected a redirect');
            const url = new URL(begun.url);
            expect(url.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
            expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
            const { account } = await engine.auth.complete({ params: { state: url.searchParams.get('state')!, code: 'code-1' } });
            return account.id;
        }
    };
}

const byName = (tools: readonly AnyTool[], name: string): AnyTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
};
const ctx = () => ({ signal: new AbortController().signal, toolCallId: 'call_1' });

async function opened(h: Harness) {
    const account = await h.connect();
    return { account, connector: await conduitTools(h.engine, { id: 'gmail', connector: 'gmail', account, owner: OWNER }) };
}

describe('conduitTools — operations → tools', () => {
    it('names one tool per action / search operation `<id>__<operation>`, no options or triggers', async () => {
        const { connector } = await opened(harness());
        expect(connector.toolNames).toEqual([
            'gmail__send-email',
            'gmail__create-draft',
            'gmail__reply-to-message',
            'gmail__search-messages',
            'gmail__get-message',
            'gmail__get-thread',
            'gmail__get-attachment',
            'gmail__modify-labels',
            'gmail__trash-message'
        ]);
        expect(connector.tools.map((t) => t.name)).toEqual(connector.toolNames);
        await connector.close();
    });

    it('namespaces under the workspace connector id, sanitised as for MCP connectors', async () => {
        const h = harness();
        const account = await h.connect();
        const c = await conduitTools(h.engine, { id: 'mail.work', connector: 'gmail', account, owner: OWNER });
        expect(c.toolNames[0]).toBe('mail_work__send-email');
        expect(connectorToolName('mail.work', 'get-message')).toBe('mail_work__get-message');
    });

    it("takes the schema and description from the spec, without the `x-` UI hints", async () => {
        const { connector } = await opened(harness());
        const send = byName(connector.tools, 'gmail__send-email');
        expect(send.description).toBe('Send email. Send a message, with optional attachments.');
        const schema = send.spec.inputSchema as { type: string; properties: Record<string, { type: string; items?: unknown }>; required?: string[] };
        expect(schema.type).toBe('object');
        expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['to', 'cc', 'bcc', 'subject', 'body', 'threadId']));
        expect(schema.required).toEqual(expect.arrayContaining(['subject', 'body']));
        expect(schema.properties.to!.type).toBe('array');
        for (const t of connector.tools) expect(JSON.stringify(t.spec.inputSchema)).not.toMatch(/"x-/);
        expect(byName(connector.tools, 'gmail__get-message').description).toBe('Get message');
    });

    it('hints from the spec: search and GET-only actions read, the destructive op is destructive, the rest un-hinted', async () => {
        const { connector } = await opened(harness());
        const hints = Object.fromEntries(connector.tools.map((t) => [t.name, t.annotations]));
        expect(hints).toEqual({
            'gmail__send-email': undefined,
            'gmail__create-draft': undefined,
            // reads the original in a GET step, then POSTs the reply
            'gmail__reply-to-message': undefined,
            'gmail__search-messages': { readOnly: true },
            'gmail__get-message': { readOnly: true },
            'gmail__get-thread': { readOnly: true },
            'gmail__get-attachment': { readOnly: true },
            'gmail__modify-labels': undefined,
            'gmail__trash-message': { destructive: true }
        });
    });

    it('never reads intent from an operation name', () => {
        const op = (o: Partial<OperationSpec> & { id: string }): OperationSpec => ({ kind: 'action', label: o.id, request: { url: '/x' }, ...o }) as OperationSpec;
        expect(operationAnnotations(op({ id: 'delete-everything', request: { method: 'POST', url: '/x' } }))).toBeUndefined();
        expect(operationAnnotations(op({ id: 'get-or-create', request: { method: 'PUT', url: '/x' } }))).toBeUndefined();
        expect(operationAnnotations(op({ id: 'send', request: { method: '{{ inputs.verb }}', url: '/x' } }))).toBeUndefined();
        expect(operationAnnotations(op({ id: 'archive', destructive: true, request: { url: '/x' } }))).toEqual({ destructive: true });
        expect(operationAnnotations(op({ id: 'send-it', request: { method: 'HEAD', url: '/x' } }))).toEqual({ readOnly: true });
        expect(operationAnnotations(op({ id: 'lookup', steps: [{ url: '/a', method: 'POST' }] as never }))).toBeUndefined();
        expect(operationAnnotations({ kind: 'search', id: 'purge', label: 'x', request: { method: 'POST', url: '/q' } })).toEqual({ readOnly: true });
    });
});

describe('conduitTools — execute', () => {
    it('runs a search and returns the mapped items', async () => {
        const h = harness();
        const { connector } = await opened(h);
        const out = await byName(connector.tools, 'gmail__search-messages').run({ query: 'is:unread' }, ctx());
        expect(out).toEqual([
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't1' }
        ]);
        const list = h.google.seen.find((s) => s.url.startsWith(`${GMAIL}/messages?`))!;
        expect(new URL(list.url).searchParams.get('q')).toBe('is:unread');
        expect(list.auth).toBe('Bearer at-1');
    });

    it("maps a message through the spec's output", async () => {
        const { connector } = await opened(harness());
        const out = (await byName(connector.tools, 'gmail__get-message').run({ id: 'm1' }, ctx())) as Record<string, unknown>;
        expect(out).toMatchObject({ id: 'm1', threadId: 't1', from: 'ada@example.com', subject: 'Lunch', text: 'Lunch on Friday?', labelIds: ['INBOX', 'UNREAD'], attachments: [] });
    });

    it('sends through the spec: POST with the raw message', async () => {
        const h = harness();
        const { connector } = await opened(h);
        const out = await byName(connector.tools, 'gmail__send-email').run({ to: ['ada@example.com'], subject: 'Hi', body: 'Hello', format: 'text' }, ctx());
        expect(out).toEqual({ id: 'm9', threadId: 't9', labelIds: ['SENT'] });
        const send = h.google.seen.find((s) => s.url === `${GMAIL}/messages/send`)!;
        expect(send.method).toBe('POST');
        expect(typeof (JSON.parse(send.body) as { raw: unknown }).raw).toBe('string');
    });

    it("surfaces the spec's own validation as a tool error", async () => {
        const { connector } = await opened(harness());
        const call = byName(connector.tools, 'gmail__send-email').run({ subject: 'Hi', body: 'Hello' }, ctx());
        await expect(call).rejects.toBeInstanceOf(ConnectorToolError);
        await expect(call).rejects.toThrow(/Invalid arguments: .*at least one recipient/i);
    });

    it('a missing required argument is refused before anything is sent', async () => {
        const h = harness();
        const { connector } = await opened(h);
        const before = h.google.seen.length;
        await expect(byName(connector.tools, 'gmail__get-message').run({}, ctx())).rejects.toThrow();
        expect(h.google.seen.length).toBe(before);
    });

    it('a revoked grant marks the account needsReauth and tells the agent to ask the owner to reconnect', async () => {
        const h = harness();
        const { account, connector } = await opened(h);
        h.google.state.revoked = true;
        const tool = byName(connector.tools, 'gmail__get-message');
        const first = await tool.run({ id: 'm1' }, ctx()).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(first).toBeInstanceOf(ConnectorToolError);
        expect((first as ConnectorToolError).code).toBe('needs_reauth');
        expect((first as ConnectorToolError).tool).toBe('gmail__get-message');
        expect((first as Error).message).toMatch(/Gmail account .* needs to be reconnected/);
        expect((first as Error).message).toMatch(/Ask the workspace owner to reconnect it/);
        expect((first as Error).message).not.toMatch(/rt-1|at-1|client-shh/);
        expect((await h.engine.accounts.get(account, OWNER))?.status).toBe('needsReauth');

        // Still opens; every call says the same, without reaching Google.
        const again = await conduitTools(h.engine, { id: 'gmail', connector: 'gmail', account, owner: OWNER });
        const before = h.google.seen.length;
        await expect(byName(again.tools, 'gmail__search-messages').run({}, ctx())).rejects.toMatchObject({ code: 'needs_reauth' });
        expect(h.google.seen.length).toBe(before);
    });
});

describe('network: grants on the conduit fetch (#642)', () => {
    /** The same workspace's engine over the same accounts, behind the plugin's granted `network:` hosts — as a session opens it. */
    const guarded = (h: Harness, allowedHosts: readonly string[]) =>
        createConnectorEngine({
            secret: 'a-workspace-secret-that-is-long-enough-0123456789',
            accounts: h.accounts,
            transient: memoryTransient(),
            locks: inProcessLocks(),
            clients: clientFromSecrets(async (name) => ({ 'gmail-client-id': 'cid.apps.googleusercontent.com', 'gmail-client-secret': 'client-shh' })[name], 'gmail'),
            redirectUri: REDIRECT,
            http: h.google.http,
            allowedHosts
        });

    it('with network:gmail.googleapis.com revoked, a Gmail tool call fails with a clear permission error and Google sees nothing', async () => {
        const h = harness();
        const account = await h.connect();
        const engine = guarded(h, ['oauth2.googleapis.com']);
        const connector = await conduitTools(engine, { id: 'gmail', connector: 'gmail', account, owner: OWNER });
        const before = h.google.seen.length;
        const failure = await byName(connector.tools, 'gmail__search-messages').run({ query: 'is:unread' }, ctx()).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(ConnectorToolError);
        expect((failure as ConnectorToolError).code).toBe('network_not_granted');
        expect((failure as ConnectorToolError).tool).toBe('gmail__search-messages');
        expect((failure as Error).message).toBe("Permission denied: network:gmail.googleapis.com is not granted to this connector: the workspace owner can grant it on the connector's plugin page.");
        // Scrubbed: no path, query, token or client secret.
        expect((failure as Error).message).not.toMatch(/users\/me|is:unread|at-1|rt-1|client-shh/);
        // Refused before it was sent, and not retried.
        expect(h.google.seen.length).toBe(before);
    });

    it('with both Google hosts granted, the same call goes through', async () => {
        const h = harness();
        const account = await h.connect();
        const connector = await conduitTools(guarded(h, ['gmail.googleapis.com', 'oauth2.googleapis.com']), { id: 'gmail', connector: 'gmail', account, owner: OWNER });
        const out = await byName(connector.tools, 'gmail__search-messages').run({ query: 'is:unread' }, ctx());
        expect(out).toBeDefined();
        expect(h.google.seen.some((r) => r.url.startsWith(GMAIL))).toBe(true);
    });

    it('guardHttp matches a grant by host or hostname and names only the scope', async () => {
        expect(connectorHostAllowed(['gmail.googleapis.com'], new URL('https://gmail.googleapis.com/x'))).toBe(true);
        expect(connectorHostAllowed(['gmail.googleapis.com'], new URL('https://gmail.googleapis.com:8443/x'))).toBe(true);
        expect(connectorHostAllowed(['gmail.googleapis.com'], new URL('https://evil.example/x'))).toBe(false);
        let sent = 0;
        const http = guardHttp(async () => {
            sent++;
            return new Response('ok');
        }, ['gmail.googleapis.com']);
        const failure = await http(new Request('https://evil.example/leak?token=abc123')).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(ConnectorNetworkError);
        expect((failure as ConnectorNetworkError).scope).toBe('network:evil.example');
        expect((failure as Error).message).not.toMatch(/leak|abc123/);
        expect(sent).toBe(0);
        expect(await (await http(new Request('https://gmail.googleapis.com/x'))).text()).toBe('ok');
    });
});

describe('conduitTools — opening', () => {
    it("refuses an account that is not the owner's, not there, or another connector's", async () => {
        const h = harness();
        const account = await h.connect();
        await expect(conduitTools(h.engine, { id: 'gmail', connector: 'gmail', account, owner: 'ws_other' })).rejects.toThrow(/not connected/);
        await expect(conduitTools(h.engine, { id: 'gmail', connector: 'gmail', account: 'acct_nope', owner: OWNER })).rejects.toThrow(/not connected/);
        const stored = (await h.accounts.get(account))!;
        await h.accounts.update({ ...stored, connector: 'outlook', version: stored.version + 1 }, stored.version);
        await expect(conduitTools(h.engine, { id: 'gmail', connector: 'gmail', account, owner: OWNER })).rejects.toThrow(/is a outlook account/);
    });
});

describe('clientFromSecrets', () => {
    it('builds the OAuth client from the plugin secrets, per lookup', async () => {
        const asked: string[] = [];
        const resolve = clientFromSecrets(async (name, lookup) => {
            asked.push(`${lookup.connector}/${lookup.method}:${name}`);
            return { 'gmail-client-id': 'cid', 'gmail-client-secret': 'cs' }[name];
        }, 'gmail');
        expect(await resolve({ connector: 'gmail', method: 'oauth', owner: OWNER })).toEqual({ id: 'cid', secret: 'cs' });
        expect(asked).toEqual(['gmail/oauth:gmail-client-id', 'gmail/oauth:gmail-client-secret']);
    });

    it('no client id → no client; no secret → a public client', async () => {
        expect(await clientFromSecrets(async () => undefined, 'gmail')({ connector: 'gmail', method: 'oauth' })).toBeUndefined();
        expect(await clientFromSecrets(async (n) => (n === 'gmail-client-id' ? 'cid' : undefined), 'gmail')({ connector: 'gmail', method: 'oauth' })).toEqual({ id: 'cid' });
    });

    it('two conduit connector plugins declare and resolve their own OAuth clients (#548)', async () => {
        const work = conduitConnectorManifest(gmailSpec, { id: 'gmail-work', hosts: ['gmail.googleapis.com'] });
        const declared = (m: typeof work): string[] => (m.secrets ?? []).filter((s) => s.required).map((s) => s.name);
        expect(declared(gmailConnectorPlugin)).toEqual(['gmail-client-id', 'gmail-client-secret']);
        expect(declared(work)).toEqual(['gmail-work-client-id', 'gmail-work-client-secret']);
        expect(connectorClientSecretNames('gmail-work')).toEqual({ id: 'gmail-work-client-id', secret: 'gmail-work-client-secret' });
        // The Registry caps secret names at 128 characters.
        expect(connectorClientSecretNames('x'.repeat(114)).secret).toHaveLength(128);
        expect(() => connectorClientSecretNames('x'.repeat(115))).toThrow(/too long.*at most 114/);
        // One workspace-wide name space, as the Registry keeps it.
        const registry: Record<string, string> = { 'gmail-client-id': 'personal', 'gmail-client-secret': 'personal-shh', 'gmail-work-client-id': 'work', 'gmail-work-client-secret': 'work-shh' };
        const lookup = { connector: 'gmail', method: 'oauth', owner: OWNER };
        expect(await clientFromSecrets(async (n) => registry[n], gmailConnectorPlugin.id)(lookup)).toEqual({ id: 'personal', secret: 'personal-shh' });
        expect(await clientFromSecrets(async (n) => registry[n], work.id)(lookup)).toEqual({ id: 'work', secret: 'work-shh' });
        // The engine secret stays one per workspace: both declare the same name.
        expect(work.secrets?.find((s) => !s.required)?.name).toBe('connector-engine-secret');
        expect(gmailConnectorPlugin.secrets?.find((s) => !s.required)?.name).toBe('connector-engine-secret');
    });

    it('sends the client secret to the token endpoint only', async () => {
        const h = harness();
        await h.connect();
        const token = h.google.seen.find((s) => s.url === TOKEN)!;
        expect(new URLSearchParams(token.body).get('client_secret')).toBe('client-shh');
        for (const s of h.google.seen.filter((x) => x.url !== TOKEN)) expect(`${s.url} ${s.body} ${s.auth}`).not.toContain('client-shh');
    });

    it('a sign-in without a client id set is refused', async () => {
        const h = harness({});
        await expect(h.engine.auth.begin({ connector: 'gmail', method: 'oauth', owner: OWNER })).rejects.toThrow();
    });
});

describe('gmailConnectorPlugin', () => {
    it('is a connector plugin that declares everything it touches', () => {
        const m = gmailConnectorPlugin;
        expect(m).toMatchObject({ id: 'gmail', kind: 'connector', name: 'Gmail', version: '1.0.0' });
        expect(m.secrets?.map((s) => [s.name, s.required])).toEqual([
            ['gmail-client-id', true],
            ['gmail-client-secret', true],
            // Generated on the first Connect (#533), so it never holds readiness back.
            ['connector-engine-secret', false]
        ]);
        expect(m.permissions.map((p) => p.scope)).toEqual(['secret:gmail-client-id', 'secret:gmail-client-secret', 'secret:connector-engine-secret', 'network:gmail.googleapis.com', 'network:oauth2.googleapis.com', 'tools:gmail']);
    });

    it('lists its operations as capabilities, and the trigger it runs by polling (AGT-09, #535)', () => {
        expect(gmailConnectorPlugin.capabilities).toEqual([
            'operation:send-email',
            'operation:create-draft',
            'operation:reply-to-message',
            'operation:search-messages',
            'operation:get-message',
            'operation:get-thread',
            'operation:get-attachment',
            'operation:modify-labels',
            'operation:trash-message',
            'trigger:new-email'
        ]);
    });

    it('declares its 9 tools; send, reply and trash ask, the rest allow (PLG-09, #632)', () => {
        const tools = gmailConnectorPlugin.tools ?? [];
        expect(tools).toHaveLength(9);
        expect(Object.fromEntries(tools.map((t) => [t.name, t.defaultMode]))).toEqual({
            'gmail__send-email': 'ask',
            'gmail__reply-to-message': 'ask',
            'gmail__trash-message': 'ask',
            'gmail__create-draft': 'allow',
            'gmail__modify-labels': 'allow',
            'gmail__search-messages': 'allow',
            'gmail__get-message': 'allow',
            'gmail__get-thread': 'allow',
            'gmail__get-attachment': 'allow'
        });
        const send = gmailSpec.operations.find((op) => op.id === 'send-email')!;
        expect(tools.find((t) => t.name === 'gmail__send-email')).toEqual({
            name: 'gmail__send-email',
            title: send.label,
            ...(send.description ? { description: send.description } : {}),
            defaultMode: 'ask'
        });
    });
});

describe('conduitConnectorManifest tools', () => {
    it('names tools under the plugin id and derives the mode from the hints unless askByDefault names the operation', () => {
        const spec = {
            ...gmailSpec,
            operations: gmailSpec.operations.filter((op) => ['search-messages', 'trash-message', 'modify-labels', 'new-email'].includes(op.id))
        };
        const m = conduitConnectorManifest(spec, { id: 'gmail-work', hosts: [] });
        // A trigger is not a tool; a search is allowed, a write without hints too, and trash (destructive in the spec) asks on its hint alone.
        expect(m.tools?.map((t) => t.name)).toEqual(['gmail-work__search-messages', 'gmail-work__modify-labels', 'gmail-work__trash-message']);
        expect(m.tools?.find((t) => t.name === 'gmail-work__search-messages')?.defaultMode).toBe('allow');
        expect(m.tools?.find((t) => t.name === 'gmail-work__modify-labels')?.defaultMode).toBe('allow');
        expect(m.tools?.find((t) => t.name === 'gmail-work__trash-message')?.defaultMode).toBe('ask');
        const asked = conduitConnectorManifest(spec, { id: 'gmail-work', hosts: [], askByDefault: ['search-messages'] });
        expect(asked.tools?.find((t) => t.name === 'gmail-work__search-messages')?.defaultMode).toBe('ask');
        // A destructive hint asks on its own.
        const destructive = { ...spec, operations: spec.operations.map((op) => (op.id === 'modify-labels' ? { ...op, destructive: true } : op)) } as typeof spec;
        expect(conduitConnectorManifest(destructive, { hosts: [] }).tools?.find((t) => t.name === 'gmail__modify-labels')?.defaultMode).toBe('ask');
    });
});

describe('createConnectorEngine', () => {
    const base = { accounts: memoryAccounts(), transient: memoryTransient(), locks: inProcessLocks(), clients: () => undefined };
    it('refuses a short secret and a redirect URI that is not an absolute http(s) URL', () => {
        expect(() => createConnectorEngine({ ...base, secret: 'short', redirectUri: REDIRECT })).toThrow(/at least 32 characters/);
        expect(() => createConnectorEngine({ ...base, secret: 'x'.repeat(32), redirectUri: '/_agentic/connectors/callback' })).toThrow(/not an absolute URL/);
        expect(() => createConnectorEngine({ ...base, secret: 'x'.repeat(32), redirectUri: 'javascript:alert(1)' })).toThrow(/must be http\(s\)/);
        expect(() => createConnectorEngine({ ...base, secret: 'x'.repeat(32), redirectUri: REDIRECT })).not.toThrow();
    });
});

/** Every module specifier in `text`: static imports and re-exports, side-effect imports, dynamic `import()`, either quote. */
function specifiersOf(text: string): string[] {
    const patterns = [/\bfrom\s*(['"])([^'"]+)\1/g, /\bimport\s*(['"])([^'"]+)\1/g, /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g];
    return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[2]!));
}

describe('edge safety', () => {
    const sources = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

    it('finds every import form', () => {
        const text = `import a from "node:fs";\nexport { b } from '@aigntiq/conduit/node';\nimport 'node:path';\nconst c = await import("node:crypto");`;
        expect(specifiersOf(text).sort()).toEqual(['@aigntiq/conduit/node', 'node:crypto', 'node:fs', 'node:path']);
    });

    it("imports no `node:` module, never conduit's `/node` subpath, never the platform", () => {
        const files = sources(join(import.meta.dirname, '..', 'src'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const bad = specifiersOf(readFileSync(file, 'utf8')).filter((s) => s.startsWith('node:') || s.startsWith('@aigntiq/conduit/node') || s.startsWith('@agentic/platform'));
            expect(bad, file).toEqual([]);
        }
    });
});
