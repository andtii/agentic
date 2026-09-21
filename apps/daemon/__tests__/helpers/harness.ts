/** Harness packages for tests (#369): a zip shaped like `package.mjs --harness` builds, and a local server to download it from. */

import type { ReleaseAsset } from '@agentic/core';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { treeHash } from '../../scripts/lib/harness.mjs';
import { writeZip } from '../../scripts/lib/zip.mjs';

export const PLATFORM = `${process.platform}-${process.arch}`;

export interface FakeHarness {
    readonly file: string;
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly version: string;
    /** The executable, relative to the package root. */
    readonly binary: string;
    /** `ReleaseAsset` minus the url. */
    asset(url: string): ReleaseAsset;
}

/**
 * `harness-<runtime>-<version>.zip` in `dir`: `node_modules/fake-<runtime>/bin/run` (and a second file) plus `manifest.json`
 * with the tree digest `package.mjs` writes. `tamper: 'tree'` lies about the digest, `'escape'` adds an entry that climbs
 * out of the package, `manifest` overrides manifest fields.
 */
export async function fakeHarnessZip(dir: string, runtime: string, version: string, options: { readonly tamper?: 'tree' | 'escape'; readonly manifest?: Record<string, unknown> } = {}): Promise<FakeHarness> {
    const src = join(dir, `src-${runtime}-${version}`);
    const binary = `node_modules/fake-${runtime}/bin/run${process.platform === 'win32' ? '.exe' : ''}`;
    const files: [string, string][] = [
        [binary, `${runtime} ${version}\n`],
        [`node_modules/fake-${runtime}/lib/data.txt`, 'x'.repeat(10_000)]
    ];
    for (const [rel, body] of files) {
        await mkdir(dirname(join(src, rel)), { recursive: true });
        await writeFile(join(src, rel), body);
    }
    const tree = treeHash(files.map(([rel]) => [rel, join(src, rel)]));
    const manifest = { runtime, version, platform: PLATFORM, binary, packages: [`fake-${runtime}`], sha256: options.tamper === 'tree' ? 'f'.repeat(64) : tree, ...options.manifest };
    const file = join(dir, `harness-${runtime}-${version}.zip`);
    writeZip(file, [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ...(await Promise.all(files.map(async ([rel]) => ({ name: rel, data: await readFile(join(src, rel)), mode: rel === binary ? 0o755 : 0o644 })))),
        ...(options.tamper === 'escape' ? [{ name: '../../escaped.txt', data: Buffer.from('out') }] : [])
    ]);
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { file, bytes, sha256, version, binary, asset: (url) => ({ url, sha256, bytes: bytes.length, version }) };
}

export interface FileServer {
    /** The URL `name` is served at. */
    url(name: string): string;
    put(name: string, body: Buffer | string): void;
    /** Paths requested so far. */
    readonly requests: string[];
    close(): Promise<void>;
}

/** A plain HTTP server over an in-memory map; anything else is a 404. */
export async function serveFiles(): Promise<FileServer> {
    const files = new Map<string, Buffer>();
    const requests: string[] = [];
    const server = createServer((req, res) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        requests.push(path);
        const body = files.get(path);
        if (!body) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: (name) => `http://127.0.0.1:${port}/${name}`,
        put: (name, body) => files.set(`/${name}`, Buffer.isBuffer(body) ? body : Buffer.from(body)),
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve()))
    };
}

/**
 * Release assets at `https://releases.test/<name>` served by an injected `fetch` — the frames a platform sends carry
 * `https:` URLs only, and the daemon takes its `fetch` from `DaemonHarnesses.fetch`.
 */
export function fakeReleases(): Omit<FileServer, 'close'> & { readonly fetch: typeof fetch } {
    const files = new Map<string, Buffer>();
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);
        const body = files.get(url);
        return body ? new Response(new Uint8Array(body)) : new Response('not found', { status: 404 });
    }) as typeof fetch;
    return {
        url: (name) => `https://releases.test/${name}`,
        put: (name, body) => files.set(`https://releases.test/${name}`, Buffer.isBuffer(body) ? body : Buffer.from(body)),
        requests,
        fetch: fetchImpl
    };
}
