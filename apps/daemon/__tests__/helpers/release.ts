/**
 * A daemon release for the update tests (#364): a zip shaped like `scripts/package.mjs` builds it (the install
 * scripts at its root and a `bin/agentic-daemon.mjs` that prints its version line), and a local HTTP server that
 * serves it with a manifest — `http://127.0.0.1`, which only a test's `allowLoopbackHttp` lets the client fetch.
 */

import type { ReleaseAsset } from '@agentic/core';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { writeZip } from '../../scripts/lib/zip.mjs';

/** Write a release zip for `version` into `dir`; `withInstall: false` leaves out the install scripts (not a daemon package). */
export function releaseZip(dir: string, version: string, options: { readonly name?: string; readonly withInstall?: boolean } = {}): { readonly file: string; readonly bytes: Uint8Array<ArrayBuffer>; readonly sha256: string } {
    const file = join(dir, options.name ?? `agentic-daemon-${version}.zip`);
    const text = (s: string) => new TextEncoder().encode(s);
    const entries = [
        ...(options.withInstall === false ? [] : [{ name: 'install.ps1', data: text('# install\n') }, { name: 'install.sh', data: text('#!/bin/sh\n'), mode: 0o755 }]),
        { name: 'package.json', data: text(JSON.stringify({ version })) },
        { name: 'bin/agentic-daemon.mjs', data: text(`process.stdout.write('agentic-daemon ${version} (abc1234, protocol 1, stable)\\n');\n`), mode: 0o755 }
    ];
    writeZip(file, entries);
    const bytes = new Uint8Array(readFileSync(file));
    return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface ReleaseServer {
    readonly origin: string;
    /** Requests seen, by path. */
    readonly requests: string[];
    /** Serve `body` at `path`; `delayMs` holds the response open first (a slow download). */
    serve(path: string, body: Uint8Array | string, options?: { readonly delayMs?: number }): void;
    close(): Promise<void>;
}

export async function startReleaseServer(): Promise<ReleaseServer> {
    const routes = new Map<string, { body: Uint8Array | string; delayMs: number }>();
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
        const path = req.url ?? '/';
        requests.push(path);
        const route = routes.get(path);
        if (!route) {
            res.writeHead(404).end();
            return;
        }
        const body = typeof route.body === 'string' ? Buffer.from(route.body) : Buffer.from(route.body);
        const send = () => {
            if (res.destroyed) return;
            res.writeHead(200, { 'content-length': body.byteLength });
            // In two halves, so a download sees more than one chunk.
            res.write(body.subarray(0, body.byteLength >> 1));
            setTimeout(() => res.end(body.subarray(body.byteLength >> 1)), 5);
        };
        if (route.delayMs > 0) setTimeout(send, route.delayMs);
        else send();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        requests,
        serve(path, body, options = {}) {
            routes.set(path, { body, delayMs: options.delayMs ?? 0 });
        },
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            })
    };
}

/** The asset for a zip served at `url`. */
export const assetOf = (url: string, zip: { readonly bytes: Uint8Array; readonly sha256: string }, version: string): ReleaseAsset => ({ url, sha256: zip.sha256, bytes: zip.bytes.byteLength, version });
