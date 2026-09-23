/**
 * A fake Google for the connector tests inside workerd (#533), and one conduit tool call the way a session makes it.
 *
 * - The token endpoint trades `code-ok` for a refresh token that renews, and `code-revoked` for one Google refuses
 *   (`invalid_grant`). Both access tokens it issues first expire within conduit's 60 s refresh skew, so the FIRST tool
 *   call refreshes. A renewed token is `at-2`; only it lists messages.
 * - A MAILBOX for the trigger tests (#535): `code-mail` signs in `mail@example.com` with a token that lasts an hour
 *   (`at-m`). Its `messages.list` honours `after:<epoch s>` and answers newest first; `messages.get` answers the
 *   headers. `POST /__test/google/mail` `{ id, from, subject, snippet }` delivers a message now;
 *   `POST /__test/google/mail/revoke` revokes the sign-in (`at-m` 401, its refresh `invalid_grant`).
 * - `GET /__test/google/log` answers what it saw, one `METHOD path grant` line per request, so a test can say a
 *   refresh happened without seeing a token.
 * - `POST /__test/connectors/call` `{ workspaceId, pluginId, tool, input }` opens the workspace's connector through
 *   the PRODUCTION opener (`conduitOpener`) as a session's agent principal, the plugin's secrets opened as the owner
 *   (as `createSessionFactory` does), and runs one tool: `{ output }` or `{ error: { code, message } }`.
 */
import type { WorkspaceId } from '@agentic/core';
import { asPrincipal, mintAgentPrincipal, Registry, registryKey, userPrincipal } from '@agentic/platform';
import { actor } from '@sigx/actors';
import { openPluginSecret, type ConnectorHttp, type ConnectorRegistry } from '../../src/connectors/engine';
import { conduitOpener } from '../../src/connectors/opener';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Mail {
    readonly id: string;
    readonly at: number;
    readonly from: string;
    readonly subject: string;
    readonly snippet: string;
}

export function fakeGoogle() {
    const log: string[] = [];
    const mailbox: Mail[] = [];
    const mail = { revoked: false };
    const http: ConnectorHttp = async (request) => {
        const body = request.method === 'GET' ? '' : new TextDecoder().decode(await request.arrayBuffer());
        const url = new URL(request.url);
        const form = new URLSearchParams(body);
        log.push(`${request.method} ${url.host}${url.pathname} ${form.get('grant_type') ?? ''}`.trim());
        if (request.url === TOKEN_URL) {
            const grant = form.get('grant_type');
            if (grant === 'authorization_code') {
                const code = form.get('code');
                if (code === 'code-ok') return json({ access_token: 'at-1', refresh_token: 'rt-ok', expires_in: 30, token_type: 'Bearer' });
                if (code === 'code-revoked') return json({ access_token: 'at-x', refresh_token: 'rt-revoked', expires_in: 30, token_type: 'Bearer' });
                if (code === 'code-mail') {
                    mail.revoked = false;
                    return json({ access_token: 'at-m', refresh_token: 'rt-mail', expires_in: 3600, token_type: 'Bearer' });
                }
                return json({ error: 'invalid_grant', error_description: 'Bad code.' }, 400);
            }
            if (grant === 'refresh_token') {
                if (form.get('refresh_token') === 'rt-ok') return json({ access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' });
                if (form.get('refresh_token') === 'rt-mail' && !mail.revoked) return json({ access_token: 'at-m', expires_in: 3600, token_type: 'Bearer' });
                return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
            }
            return json({ error: 'unsupported_grant_type' }, 400);
        }
        if (url.href.startsWith(REVOKE_URL)) return new Response(null, { status: 200 });
        if (!request.url.startsWith(GMAIL)) return json({ error: { message: `no route ${request.url}` } }, 404);
        const auth = request.headers.get('authorization');
        const path = url.pathname.replace('/gmail/v1/users/me', '');
        if (auth === 'Bearer at-m') {
            if (mail.revoked) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
            if (path === '/profile') return json({ emailAddress: 'mail@example.com' });
            if (path === '/messages') {
                const after = /after:(\d+)/.exec(url.searchParams.get('q') ?? '');
                const bound = after ? Number(after[1]) * 1000 : 0;
                const hits = mailbox.filter((m) => m.at > bound).sort((a, b) => b.at - a.at);
                return json(hits.length ? { messages: hits.map((m) => ({ id: m.id, threadId: `t_${m.id}` })) } : { resultSizeEstimate: 0 });
            }
            const one = mailbox.find((m) => path === `/messages/${m.id}`);
            if (one) {
                return json({
                    id: one.id,
                    threadId: `t_${one.id}`,
                    labelIds: ['INBOX', 'UNREAD'],
                    snippet: one.snippet,
                    internalDate: String(one.at),
                    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: one.from }, { name: 'Subject', value: one.subject }], body: { data: '' } }
                });
            }
            return json({ error: { message: 'Requested entity was not found.' } }, 404);
        }
        if (path === '/profile') {
            if (auth === 'Bearer at-1' || auth === 'Bearer at-2') return json({ emailAddress: 'owner@example.com' });
            if (auth === 'Bearer at-x') return json({ emailAddress: 'revoked@example.com' });
        }
        if (path === '/messages' && auth === 'Bearer at-2') return json({ messages: [{ id: 'm1', threadId: 't1' }] });
        return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    };
    return {
        http,
        log,
        route(request: Request): ((request: Request) => Promise<Response>) | undefined {
            const path = new URL(request.url).pathname;
            if (path === '/__test/google/log') return async () => json({ log });
            if (path === '/__test/google/mail/revoke') {
                return async () => {
                    mail.revoked = true;
                    return json({ revoked: true });
                };
            }
            if (path === '/__test/google/mail') {
                return async (req) => {
                    const m = (await req.json()) as Omit<Mail, 'at'>;
                    mailbox.push({ ...m, at: Date.now() });
                    return json({ delivered: m.id });
                };
            }
            return undefined;
        }
    };
}

interface CallBody {
    readonly workspaceId: string;
    readonly pluginId: string;
    readonly tool: string;
    readonly input: Record<string, unknown>;
}

export function conduitCall(request: Request, http: ConnectorHttp): ((request: Request) => Promise<Response>) | undefined {
    if (new URL(request.url).pathname !== '/__test/connectors/call') return undefined;
    return async (req) => {
        const body = (await req.json()) as CallBody;
        const ws = body.workspaceId as WorkspaceId;
        const registry = actor(Registry, registryKey(ws)).with({ context: asPrincipal(userPrincipal(ws, ws)) }) as unknown as ConnectorRegistry;
        const record = await registry.getConnector(body.pluginId);
        if (!record?.account || !record.connector) return json({ error: { code: 'not-connected', message: 'no account on the record' } });
        const open = conduitOpener({ http });
        const opened = await open(
            { kind: 'conduit', id: record.id, pluginId: record.pluginId, connector: record.connector, account: record.account },
            { workspaceId: ws, principal: mintAgentPrincipal({ workspaceId: ws, agentId: 'agent_mail' as never, sessionId: 'session_mail' as never }), secret: (name, pluginId) => openPluginSecret(registry, name, pluginId) }
        );
        const tool = opened.tools.find((t) => t.name === body.tool);
        if (!tool) return json({ error: { code: 'no-tool', message: `no ${body.tool} among ${opened.toolNames.join(', ')}` }, toolNames: opened.toolNames });
        try {
            const output = await (tool as unknown as { run(input: unknown, ctx: unknown): Promise<unknown> }).run(body.input, { signal: new AbortController().signal, toolCallId: 'call_1' });
            return json({ output, toolNames: opened.toolNames });
        } catch (e) {
            return json({ error: { code: (e as { code?: string }).code ?? 'error', message: e instanceof Error ? e.message : String(e) }, toolNames: opened.toolNames });
        } finally {
            await opened.close();
        }
    };
}
