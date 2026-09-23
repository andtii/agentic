/**
 * The Gmail polling trigger (#535) against the real Gmail spec of `@aigntiq/conduit-connectors` and a fake mailbox:
 * the first poll looks back a bounded window, a new message is one arrival, a re-poll with the returned cursor is
 * none, a burst is taken oldest first a few at a time without losing the rest, and an account that needs
 * reconnecting is a verdict, not a throw.
 */
import { inProcessLocks, memoryAccounts, memoryTransient } from '@aigntiq/conduit';
import { describe, expect, it } from 'vitest';
import { clientFromSecrets, createConnectorEngine, gmailArrivalText, parseGmailCursor, pollGmail, type ConnectorEngine } from '../src/index';

const OWNER = 'ws_1';
const TOKEN = 'https://oauth2.googleapis.com/token';
const T0 = Date.parse('2026-09-23T12:00:00Z');
const MIN = 60_000;

interface Mail {
    readonly id: string;
    readonly at: number;
    readonly from: string;
    readonly subject: string;
    readonly snippet: string;
}

/** A fake Gmail: `messages.list` honours `after:<epoch s>` (newest first, as Gmail answers); `messages.get` answers the headers. */
function fakeMailbox() {
    const mails: Mail[] = [];
    const queries: string[] = [];
    const state = { revoked: false };
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const http = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (request.url === TOKEN) {
            const form = new URLSearchParams(await request.text());
            if (form.get('grant_type') === 'authorization_code') return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
            return state.revoked ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' });
        }
        if (state.revoked) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
        const path = url.pathname.replace('/gmail/v1/users/me', '');
        if (path === '/profile') return json({ emailAddress: 'owner@example.com' });
        if (path === '/messages') {
            const q = url.searchParams.get('q') ?? '';
            queries.push(q);
            const after = /after:(\d+)/.exec(q);
            const bound = after ? Number(after[1]) * 1000 : 0;
            const hits = mails.filter((m) => m.at > bound).sort((a, b) => b.at - a.at);
            return json(hits.length ? { messages: hits.map((m) => ({ id: m.id, threadId: `t_${m.id}` })) } : { resultSizeEstimate: 0 });
        }
        const one = /^\/messages\/([^/]+)$/.exec(path);
        const mail = one ? mails.find((m) => m.id === decodeURIComponent(one[1]!)) : undefined;
        if (mail) {
            return json({
                id: mail.id,
                threadId: `t_${mail.id}`,
                labelIds: ['INBOX', 'UNREAD'],
                snippet: mail.snippet,
                internalDate: String(mail.at),
                payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: mail.from }, { name: 'Subject', value: mail.subject }], body: { data: '' } }
            });
        }
        return json({ error: { message: 'Requested entity was not found.' } }, 404);
    };
    return { http, mails, queries, state };
}

async function connected(): Promise<{ engine: ConnectorEngine; account: string; box: ReturnType<typeof fakeMailbox> }> {
    const box = fakeMailbox();
    const engine = createConnectorEngine({
        secret: 'a-workspace-secret-that-is-long-enough-0123456789',
        accounts: memoryAccounts(),
        transient: memoryTransient(),
        locks: inProcessLocks(),
        clients: clientFromSecrets(async (name) => ({ 'gmail-client-id': 'cid', 'gmail-client-secret': 'shh' })[name], 'gmail'),
        redirectUri: 'https://agentic.example/_agentic/connectors/callback',
        http: box.http
    });
    const begun = await engine.auth.begin({ connector: 'gmail', method: 'oauth', owner: OWNER });
    if (begun.type !== 'redirect') throw new Error('expected a redirect');
    const { account } = await engine.auth.complete({ params: { state: new URL(begun.url).searchParams.get('state')!, code: 'c' } });
    return { engine, account: account.id, box };
}

const mail = (id: string, at: number): Mail => ({ id, at, from: `Ada <ada@example.com>`, subject: `About ${id}`, snippet: `Hello from ${id}` });

describe('pollGmail (#535)', () => {
    it('a new message is one arrival with its headers; a re-poll with the cursor finds nothing new', async () => {
        const { engine, account, box } = await connected();
        box.mails.push(mail('old', T0 - 60 * MIN), mail('m1', T0 - 2 * MIN));

        const first = await pollGmail(engine, { account, owner: OWNER, query: 'in:inbox', now: T0 });
        expect(first.kind).toBe('arrivals');
        if (first.kind !== 'arrivals') return;
        // Only what arrived inside the first look-back: the hour-old message is history, not news.
        expect(first.arrivals).toEqual([{ id: 'm1', threadId: 't_m1', from: 'Ada <ada@example.com>', subject: 'About m1', snippet: 'Hello from m1', receivedAt: new Date(T0 - 2 * MIN).toISOString() }]);
        expect(box.queries[0]).toBe(`(in:inbox) after:${Math.floor((T0 - 15 * MIN) / 1000)}`);

        const again = await pollGmail(engine, { account, owner: OWNER, query: 'in:inbox', now: T0 + 5 * MIN, cursor: first.cursor });
        expect(again).toMatchObject({ kind: 'arrivals', arrivals: [] });

        // The next message is news; the one before stays seen.
        box.mails.push(mail('m2', T0 + 6 * MIN));
        const third = await pollGmail(engine, { account, owner: OWNER, query: 'in:inbox', now: T0 + 10 * MIN, cursor: again.kind === 'arrivals' ? again.cursor : undefined });
        expect(third.kind === 'arrivals' && third.arrivals.map((a) => a.id)).toEqual(['m2']);
        // The window overlaps the last poll, so a message Gmail indexes late is still found.
        expect(box.queries[2]).toBe(`(in:inbox) after:${Math.floor((T0 + 5 * MIN) / 1000) - 600}`);
    });

    it('a burst is taken oldest first, a few per poll, and the rest come on the next polls', async () => {
        const { engine, account, box } = await connected();
        for (let i = 0; i < 5; i++) box.mails.push(mail(`b${i}`, T0 - (5 - i) * MIN));
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let poll = 0; poll < 3; poll++) {
            const out = await pollGmail(engine, { account, owner: OWNER, now: T0 + poll * 5 * MIN, maxArrivals: 2, ...(cursor ? { cursor } : {}) });
            if (out.kind !== 'arrivals') throw new Error(out.message);
            seen.push(...out.arrivals.map((a) => a.id));
            cursor = out.cursor;
        }
        expect(seen).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
        // No query of the owner's: the time bound alone.
        expect(box.queries[0]).toMatch(/^after:\d+$/);
    });

    it('an account whose sign-in was revoked is a needs-reauth verdict', async () => {
        const { engine, account, box } = await connected();
        box.state.revoked = true;
        // Force a refresh: conduit renews on the 401 and Google refuses it.
        const out = await pollGmail(engine, { account, owner: OWNER, now: T0 });
        expect(out.kind).toBe('needs-reauth');
    });

    it('reads a malformed cursor as none, and writes one it can read back', () => {
        expect(parseGmailCursor('nonsense')).toBeUndefined();
        expect(parseGmailCursor(JSON.stringify({ v: 1, since: 5, seen: ['a'] }))).toEqual({ since: 5, seen: ['a'] });
    });

    it('describes an arrival for the agent, naming the tool that reads it', () => {
        const text = gmailArrivalText({ id: 'm1', threadId: 't1', from: 'Ada <ada@example.com>', subject: 'Lunch', snippet: 'Friday?', receivedAt: '2026-09-23T12:00:00.000Z' }, 'gmail');
        expect(text).toContain('From: Ada <ada@example.com>');
        expect(text).toContain('Subject: Lunch');
        expect(text).toContain('gmail__get-message');
        expect(text).toContain('"m1"');
    });
});
