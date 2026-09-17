/**
 * An in-process mock platform: `POST /auth/pair` (the #32 contract) and the
 * daemon socket `/_agentic/daemon/{machineId}` behind a bearer check. Each
 * accepted connection becomes a `PlatformSeat` the test drives.
 */

import type { PlatformFrame } from '@agentic/daemon-protocol';
import { encodeFrame } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RelayOptions {
    readonly port?: number;
    /** The code `/auth/pair` accepts. */
    readonly pairingCode?: string;
    readonly workspaceId?: string;
    readonly machineId?: string;
    /** The token `/auth/pair` hands out and the socket requires. */
    readonly token?: string;
}

export interface Relay {
    readonly url: string;
    readonly port: number;
    readonly token: string;
    readonly machineId: string;
    /** Machine names seen by `/auth/pair`. */
    readonly paired: string[];
    /** Handshakes refused for a bad token. */
    readonly refused: number;
    /** Paths the daemon dialled. */
    readonly dialled: string[];
    /** The next connection the daemon makes (queued if it already happened). */
    nextSeat(timeoutMs?: number): Promise<PlatformSeat>;
    close(): Promise<void>;
}

export const TEST_WORKSPACE = 'ws_test';
export const TEST_MACHINE = 'machine_test';
export const TEST_TOKEN = `amt.${TEST_WORKSPACE}.${TEST_MACHINE}.${'s'.repeat(40)}abc`;

class Seat implements PlatformSeat {
    private readonly buffer: string[] = [];
    private waiter: { resolve(v: string): void; reject(e: Error): void } | undefined;
    private closed = false;

    constructor(private readonly ws: WebSocket) {
        ws.on('message', (data) => {
            if (this.closed) return;
            const text = data.toString();
            if (this.waiter) {
                const w = this.waiter;
                this.waiter = undefined;
                w.resolve(text);
            } else this.buffer.push(text);
        });
        ws.on('close', () => this.fail());
        // A peer that vanishes mid-frame resets the socket; that is the scenario, not a failure.
        ws.on('error', () => this.fail());
    }

    private fail(): void {
        this.closed = true;
        this.buffer.length = 0;
        this.waiter?.reject(new Error('the connection closed'));
        this.waiter = undefined;
    }

    send(frame: PlatformFrame): void {
        this.ws.send(encodeFrame(frame));
    }

    sendRaw(text: string): void {
        this.ws.send(text);
    }

    next(): Promise<unknown> {
        if (this.closed) return Promise.reject(new Error('the connection closed'));
        const head = this.buffer.shift();
        if (head !== undefined) return Promise.resolve(head);
        return new Promise((resolve, reject) => {
            this.waiter = { resolve, reject };
        });
    }

    drop(): void {
        this.fail();
        this.ws.terminate();
    }
}

export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
    const token = options.token ?? TEST_TOKEN;
    const machineId = options.machineId ?? TEST_MACHINE;
    const workspaceId = options.workspaceId ?? TEST_WORKSPACE;
    const paired: string[] = [];
    const dialled: string[] = [];
    const seats: Seat[] = [];
    const waiters: ((seat: Seat) => void)[] = [];
    let refused = 0;

    const server: Server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/auth/pair') {
            let body = '';
            req.on('data', (c: Buffer) => (body += c.toString()));
            req.on('end', () => {
                const { code, name } = JSON.parse(body || '{}') as { code?: string; name?: string };
                res.setHeader('content-type', 'application/json');
                if (code !== (options.pairingCode ?? 'ABC234')) {
                    res.statusCode = 401;
                    res.end(JSON.stringify({ error: 'mismatch' }));
                    return;
                }
                paired.push(name ?? '');
                res.end(JSON.stringify({ token, workspaceId, machineId }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    const wss = new WebSocketServer({ noServer: true });
    wss.on('error', () => {});
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
        socket.on('error', () => {});
        dialled.push(req.url ?? '');
        if (req.headers.authorization !== `Bearer ${token}` || req.url !== `/_agentic/daemon/${machineId}`) {
            refused++;
            socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const seat = new Seat(ws);
            const waiter = waiters.shift();
            if (waiter) waiter(seat);
            else seats.push(seat);
        });
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    return {
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        machineId,
        paired,
        dialled,
        get refused() {
            return refused;
        },
        nextSeat(timeoutMs = 5_000) {
            const seat = seats.shift();
            if (seat) return Promise.resolve(seat);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const i = waiters.indexOf(done);
                    if (i >= 0) waiters.splice(i, 1);
                    reject(new Error('the daemon did not connect'));
                }, timeoutMs);
                const done = (s: Seat) => {
                    clearTimeout(timer);
                    resolve(s);
                };
                waiters.push(done);
            });
        },
        async close() {
            for (const client of wss.clients) client.terminate();
            wss.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}
