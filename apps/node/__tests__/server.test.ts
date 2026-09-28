/**
 * The Node host's HTTP server (#988): static assets first, then the host's
 * `fetch` over a WinterCG `Request`; the upgrade listener routes the actor
 * socket and the daemon socket and refuses everything else.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { DaemonIdentity } from '../../web/src/daemon';
import type { NodeHost } from '../src/host';
import { createNodeServer } from '../src/server';

type FakeHost = Pick<NodeHost, 'fetch' | 'openActorSocket' | 'daemon'>;

describe('createNodeServer', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
    });

    const serve = async (host: Partial<FakeHost>): Promise<string> => {
        const client = await mkdtemp(join(tmpdir(), 'agentic-node-client-'));
        cleanup.push(() => rm(client, { recursive: true, force: true }));
        await mkdir(join(client, 'assets'));
        await writeFile(join(client, 'assets', 'app.js'), 'console.log(1)');
        await writeFile(join(client, 'index.html'), '<template>');
        const full: FakeHost = {
            fetch: async () => new Response('from the host'),
            openActorSocket: async () => ({ handle: () => undefined, close: () => undefined, stats: () => ({ inFlight: 0, subscriptions: 0, bufferedBytes: null }) }),
            daemon: { verify: async () => new Response('{}', { status: 404 }), opened: () => undefined, message: async () => undefined, closed: async () => undefined },
            ...host
        };
        const { server } = createNodeServer({ host: full as NodeHost, clientDir: client, onError: () => undefined });
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        cleanup.push(
            () =>
                new Promise<void>((done) => {
                    server.closeAllConnections();
                    server.close(() => done());
                })
        );
        return `127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    it('serves a built asset, never the raw index.html, and nothing outside the client dir', async () => {
        const seen: string[] = [];
        const at = await serve({ fetch: async (request) => (seen.push(new URL(request.url).pathname), new Response('document')) });
        const asset = await fetch(`http://${at}/assets/app.js`);
        expect(asset.headers.get('content-type')).toContain('text/javascript');
        expect(asset.headers.get('cache-control')).toContain('immutable');
        expect(await asset.text()).toBe('console.log(1)');
        expect(await (await fetch(`http://${at}/index.html`)).text()).toBe('document');
        expect(await (await fetch(`http://${at}/..%2f..%2fpackage.json`)).text()).toBe('document');
        expect(seen).toEqual(['/index.html', '/..%2f..%2fpackage.json']);
    });

    it('hands the host the method, headers and body, and writes back every set-cookie', async () => {
        const at = await serve({
            fetch: async (request) => {
                const body = await request.text();
                const headers = new Headers({ 'x-echo': `${request.method} ${request.headers.get('x-in')} ${body}` });
                headers.append('set-cookie', 'a=1; Path=/');
                headers.append('set-cookie', 'b=2; Path=/');
                return new Response('ok', { status: 201, headers });
            }
        });
        const response = await fetch(`http://${at}/auth/pair`, { method: 'POST', headers: { 'x-in': 'yes' }, body: 'payload' });
        expect(response.status).toBe(201);
        expect(response.headers.get('x-echo')).toBe('POST yes payload');
        expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    });

    it('opens an actor socket session on /_sigx/socket/* and feeds it the frames in order', async () => {
        const handled: string[] = [];
        let upgradeUrl = '';
        const at = await serve({
            openActorSocket: async (request, send) => {
                upgradeUrl = new URL(request.url).pathname;
                send('hello');
                return { handle: (m: string) => void handled.push(m), close: () => undefined, stats: () => ({ inFlight: 0, subscriptions: 0, bufferedBytes: null }) };
            }
        });
        const ws = new WebSocket(`ws://${at}/_sigx/socket/Chat/ws1%3Achat%3Ac1`);
        cleanup.push(() => ws.close());
        const first = await new Promise<string>((done) => ws.once('message', (data) => done(String(data))));
        expect(first).toBe('hello');
        ws.send('one');
        ws.send('two');
        await expect.poll(() => handled).toEqual(['one', 'two']);
        expect(upgradeUrl).toBe('/_sigx/socket/Chat/ws1%3Achat%3Ac1');
    });

    it('refuses a daemon upgrade the host refuses, before any socket opens', async () => {
        const at = await serve({ daemon: { verify: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }), opened: () => undefined, message: async () => undefined, closed: async () => undefined } });
        const ws = new WebSocket(`ws://${at}/_agentic/daemon/m1`, { headers: { authorization: 'Bearer amt.bad' } });
        const status = await new Promise<number>((done) => ws.once('unexpected-response', (_req, res) => done(res.statusCode ?? 0)));
        expect(status).toBe(401);
    });

    it('accepts a verified daemon, relays its frames in order and reports the close', async () => {
        const who = { workspaceId: 'ws1', machineId: 'm1', key: 'ws1:machine:m1', token: 't' } as DaemonIdentity;
        const events: string[] = [];
        const at = await serve({
            daemon: {
                verify: async () => who,
                opened: () => void events.push('opened'),
                message: async (_who, _ws, text) => void events.push(`message ${text}`),
                closed: async () => void events.push('closed')
            }
        });
        const ws = new WebSocket(`ws://${at}/_agentic/daemon/m1`);
        await new Promise((done) => ws.once('open', done));
        ws.send('a');
        ws.send('b');
        await expect.poll(() => events).toEqual(['opened', 'message a', 'message b']);
        ws.close();
        await expect.poll(() => events).toEqual(['opened', 'message a', 'message b', 'closed']);
    });

    it('refuses an upgrade on any other path', async () => {
        const at = await serve({});
        const ws = new WebSocket(`ws://${at}/elsewhere`);
        const status = await new Promise<number>((done) => ws.once('unexpected-response', (_req, res) => done(res.statusCode ?? 0)));
        expect(status).toBe(404);
    });
});
