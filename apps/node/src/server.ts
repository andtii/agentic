/**
 * The Node host's one HTTP server (#988): static assets first (the client
 * build, exact file paths only — the Worker's `html_handling: 'none'`), then
 * `NodeHost.fetch` over a WinterCG `Request`. One `'upgrade'` listener with a
 * `ws` server in `noServer` mode takes the sockets:
 *
 *     /_sigx/socket, /_sigx/socket/{type}/{key}   the live actor socket session
 *     /_agentic/daemon/{machineId}                a daemon (token checked before the upgrade)
 *
 * Anything else is refused with 404.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DAEMON_SOCKET_PREFIX } from '../../web/src/daemon';
import type { NodeHost } from './host';

export const ACTOR_SOCKET_PATH = '/_sigx/socket';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm'
};

/** The `Request` a Node request describes, its body streamed. `origin` stands in when the client sent no `Host`. */
export function toRequest(req: IncomingMessage, options: { origin?: string; signal?: AbortSignal } = {}): Request {
    const origin = options.origin ?? 'http://localhost';
    const url = new URL(req.url ?? '/', req.headers.host ? `http://${req.headers.host}` : origin);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = { method, headers, ...(options.signal ? { signal: options.signal } : {}) };
    if (hasBody) {
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
    }
    return new Request(url, init);
}

/** Write `response` to `res`: status, headers (every `set-cookie` kept), the body streamed. */
export async function writeResponse(res: ServerResponse, response: Response, head = false): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') headers[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, response.statusText, headers);
    if (head || !response.body) {
        res.end();
        return;
    }
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    res.once('close', () => body.destroy());
    await new Promise<void>((done) => {
        body.once('error', () => {
            res.destroy();
            done();
        });
        // 'finish' when the body is written (a keep-alive socket stays open); 'close' when the client left first.
        res.once('finish', () => done());
        res.once('close', () => done());
        body.pipe(res);
    });
}

/** The file under `root` a GET for `pathname` names, or `null` (not a file, outside `root`, or a dot-path). */
async function staticFile(root: string, pathname: string): Promise<{ path: string; size: number } | null> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (decoded.includes('\0') || decoded.endsWith('/')) return null;
    const path = resolve(root, `.${decoded}`);
    if (path !== root && !path.startsWith(root + sep)) return null;
    // `index.html` is the raw outlet template: the document is always the render's.
    if (path === join(root, 'index.html')) return null;
    try {
        const info = await stat(path);
        return info.isFile() ? { path, size: info.size } : null;
    } catch {
        return null;
    }
}

function refuseUpgrade(socket: Duplex, status: number, body = ''): void {
    const reason = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required' }[status] ?? 'Error';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

const textOf = (data: RawData): string => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8');

export interface NodeServerOptions {
    readonly host: NodeHost;
    /** The client build (`apps/web/dist/client`); absent → no static assets. */
    readonly clientDir?: string;
    /** Log a failed request. Default `console.error`. */
    readonly onError?: (error: unknown) => void;
}

export interface NodeServer {
    readonly server: Server;
    /** Mark every later response `connection: close` — the drain `attachSignalHandlers` starts. */
    draining(): void;
}

export function createNodeServer(options: NodeServerOptions): NodeServer {
    const { host } = options;
    const clientDir = options.clientDir ? resolve(options.clientDir) : undefined;
    const onError = options.onError ?? ((e: unknown) => console.error('[node] request failed:', e));
    let stopping = false;

    const server = createServer((req, res) => {
        if (stopping) res.setHeader('connection', 'close');
        void (async () => {
            try {
                const method = req.method ?? 'GET';
                if (clientDir && (method === 'GET' || method === 'HEAD')) {
                    const file = await staticFile(clientDir, new URL(req.url ?? '/', 'http://localhost').pathname);
                    if (file) {
                        const immutable = file.path.includes(`${sep}assets${sep}`);
                        res.writeHead(200, {
                            'content-type': CONTENT_TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
                            'content-length': file.size,
                            'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate'
                        });
                        if (method === 'HEAD') res.end();
                        else createReadStream(file.path).once('error', () => res.destroy()).pipe(res);
                        return;
                    }
                }
                const aborter = new AbortController();
                res.once('close', () => {
                    if (!res.writableEnded) aborter.abort();
                });
                const request = toRequest(req, { signal: aborter.signal });
                const response = await host.fetch(request);
                await writeResponse(res, response, method === 'HEAD');
            } catch (e) {
                onError(e);
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('internal error');
            }
        })();
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const request = toRequest(req);

        if (pathname === ACTOR_SOCKET_PATH || pathname.startsWith(`${ACTOR_SOCKET_PATH}/`)) {
            wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
                // Frames that arrive while the session's upgrade prelude (origin, auth) runs are queued, then fed in order.
                const pending: string[] = [];
                let session: { handle(message: string): void; close(): void } | undefined;
                let closed = false;
                ws.on('message', (data: RawData) => {
                    const text = textOf(data);
                    if (session) session.handle(text);
                    else pending.push(text);
                });
                ws.on('close', () => {
                    closed = true;
                    session?.close();
                });
                host.openActorSocket(
                    request,
                    (message) => ws.send(message),
                    (code, reason) => ws.close(code, reason)
                ).then(
                    (opened) => {
                        if (closed) return opened.close();
                        session = opened;
                        for (const text of pending.splice(0)) opened.handle(text);
                    },
                    // The session closed the socket (1008) itself when it refused the upgrade.
                    () => undefined
                );
            });
            return;
        }

        if (pathname.startsWith(DAEMON_SOCKET_PREFIX)) {
            void host.daemon.verify(request).then(
                async (who) => {
                    if (who instanceof Response) return refuseUpgrade(socket, who.status, await who.text());
                    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
                        host.daemon.opened(who, ws);
                        // Frames are handled one at a time, in order: the Machine actor's protocol is a sequence.
                        let queue = Promise.resolve();
                        ws.on('message', (data: RawData, isBinary: boolean) => {
                            if (isBinary) return ws.close(1003, 'the daemon protocol is text frames');
                            const text = textOf(data);
                            queue = queue.then(() => host.daemon.message(who, ws, text)).catch(onError);
                        });
                        ws.on('close', () => {
                            queue = queue.then(() => host.daemon.closed(who, ws)).catch(onError);
                        });
                    });
                },
                (e: unknown) => {
                    onError(e);
                    refuseUpgrade(socket, 500);
                }
            );
            return;
        }

        refuseUpgrade(socket, 404);
    });

    return {
        server,
        draining: () => {
            stopping = true;
        }
    };
}
