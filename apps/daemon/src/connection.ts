/**
 * One reconnecting WebSocket to the platform (architecture §5b): the machine
 * token rides in the `Authorization` header (never the URL, so it cannot end
 * up in a proxy or access log), and a lost connection is redialled with
 * exponential backoff and jitter — forever, until `stop()`. A refused token
 * (401/403) keeps retrying at the ceiling rather than hammering the platform.
 *
 * Built on `ws`: Node 20 has no global WebSocket, and a browser-style
 * WebSocket cannot send headers.
 */

import WebSocket from 'ws';
import type { Logger } from './logger.js';

export interface BackoffOptions {
    /** First retry delay. Default 500 ms. */
    readonly initialMs?: number;
    /** Ceiling. Default 30 s. */
    readonly maxMs?: number;
    readonly factor?: number;
    /** ± fraction of the delay. Default 0.2. */
    readonly jitter?: number;
    readonly random?: () => number;
}

/** The delay before retry number `attempt` (0-based). */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
    const initial = options.initialMs ?? 500;
    const max = options.maxMs ?? 30_000;
    const factor = options.factor ?? 2;
    const jitter = options.jitter ?? 0.2;
    const random = options.random ?? Math.random;
    const base = Math.min(max, initial * factor ** Math.max(0, attempt));
    const spread = base * jitter;
    return Math.max(0, Math.round(base - spread + random() * 2 * spread));
}

export interface Socket {
    send(text: string): void;
    close(): void;
}

export interface ConnectionHandlers {
    onOpen(socket: Socket): void;
    onMessage(text: string): void;
    onClose(info: { readonly code: number; readonly reason: string }): void;
}

export interface ConnectionOptions {
    readonly url: string;
    readonly token: string;
    readonly handlers: ConnectionHandlers;
    readonly backoff?: BackoffOptions;
    readonly logger: Logger;
    /** Largest incoming message; default 1 MiB + slack (the protocol refuses more anyway). */
    readonly maxPayload?: number;
}

export interface Connection {
    start(): void;
    stop(): Promise<void>;
    readonly connected: boolean;
}

export function reconnectingConnection(options: ConnectionOptions): Connection {
    const { logger, handlers } = options;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = true;
    let open = false;
    let refused = false;

    const schedule = (): void => {
        if (stopped) return;
        const delay = refused ? (options.backoff?.maxMs ?? 30_000) : backoffDelay(attempt++, options.backoff);
        logger.debug('platform: redial scheduled', { delayMs: delay });
        timer = setTimeout(dial, delay);
    };

    function dial(): void {
        timer = undefined;
        if (stopped) return;
        refused = false;
        const socket = new WebSocket(options.url, {
            headers: { authorization: `Bearer ${options.token}` },
            maxPayload: options.maxPayload ?? 1024 * 1024 + 64 * 1024,
            handshakeTimeout: 15_000
        });
        ws = socket;
        socket.on('open', () => {
            if (ws !== socket) return;
            attempt = 0;
            open = true;
            logger.info('platform: connected');
            handlers.onOpen({
                send: (text) => {
                    if (socket.readyState === WebSocket.OPEN) socket.send(text);
                },
                close: () => socket.close()
            });
        });
        socket.on('message', (data, isBinary) => {
            if (ws !== socket) return;
            const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
            if (isBinary) logger.debug('platform: binary message decoded as text');
            handlers.onMessage(text);
        });
        socket.on('unexpected-response', (_request, response) => {
            const status = response.statusCode ?? 0;
            refused = status === 401 || status === 403;
            logger.error(refused ? 'platform: the machine token was refused — pair again if it was revoked' : 'platform: unexpected handshake response', { status });
            socket.terminate();
        });
        socket.on('error', (e) => logger.warn('platform: socket error', { error: e }));
        socket.on('close', (code, reason) => {
            if (ws !== socket) return;
            ws = undefined;
            const wasOpen = open;
            open = false;
            if (wasOpen) {
                logger.info('platform: disconnected', { code });
                handlers.onClose({ code, reason: reason.toString('utf8') });
            }
            schedule();
        });
    }

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            dial();
        },
        async stop() {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            const socket = ws;
            if (!socket) return;
            await new Promise<void>((resolve) => {
                socket.once('close', () => resolve());
                if (socket.readyState === WebSocket.CLOSED) resolve();
                else socket.terminate();
            });
        },
        get connected() {
            return open;
        }
    };
}
