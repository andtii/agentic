import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPlatform, nodeDownload, nodePlatforms, seaConfig, sidecarFile } from './sidecar.mjs';
import { releaseConfig, withNode } from './release-config.mjs';

test("the sidecar is named as Tauri's externalBin expects", () => {
    assert.equal(sidecarFile('x86_64-pc-windows-msvc'), 'agentic-node-x86_64-pc-windows-msvc.exe');
    assert.equal(sidecarFile('aarch64-apple-darwin'), 'agentic-node-aarch64-apple-darwin');
    assert.equal(sidecarFile('universal-apple-darwin'), 'agentic-node-universal-apple-darwin');
    assert.equal(sidecarFile('x86_64-unknown-linux-gnu'), 'agentic-node-x86_64-unknown-linux-gnu');
});

test('each target runs the matching Node build', () => {
    assert.deepEqual(nodePlatforms('x86_64-pc-windows-msvc'), ['win-x64']);
    assert.deepEqual(nodePlatforms('aarch64-unknown-linux-gnu'), ['linux-arm64']);
    assert.deepEqual(nodePlatforms('x86_64-apple-darwin'), ['darwin-x64']);
    assert.deepEqual(nodePlatforms('universal-apple-darwin'), ['darwin-arm64', 'darwin-x64']);
    assert.throws(() => nodePlatforms('wasm32-unknown-unknown'), /no Node build/);
    assert.equal(hostPlatform('win32', 'x64'), 'win-x64');
    assert.equal(hostPlatform('darwin', 'arm64'), 'darwin-arm64');
});

test('another platform comes from nodejs.org at the same version', () => {
    assert.deepEqual(nodeDownload('v22.13.0', 'darwin-x64'), {
        url: 'https://nodejs.org/dist/v22.13.0/node-v22.13.0-darwin-x64.tar.gz',
        archive: true,
        entry: 'node-v22.13.0-darwin-x64/bin/node'
    });
    assert.deepEqual(nodeDownload('v22.13.0', 'win-arm64'), { url: 'https://nodejs.org/dist/v22.13.0/win-arm64/node.exe', archive: false, entry: 'node.exe' });
});

test('one blob serves every platform: no snapshot, no code cache', () => {
    assert.deepEqual(seaConfig('main.cjs', 'sea.blob'), { main: 'main.cjs', output: 'sea.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false });
});

test('--node adds the sidecar and its files to a release', () => {
    const nodeConf = JSON.parse(readFileSync(new URL('../src-tauri/node.conf.json', import.meta.url), 'utf8'));
    const config = withNode(releaseConfig('desktop-v1.0.0', {}), nodeConf);
    assert.deepEqual(config.bundle, { windows: { wix: { version: '1.0.0.65535' } }, externalBin: ['binaries/agentic-node'], resources: ['node/'] });
    assert.equal(config.version, '1.0.0');
});

/** A node that only waits for its SIGTERM, as apps/node/src/main.ts does once it listens. */
function fakeNode({ listenAfterMs = 0 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-launch-'));
    copyFileSync(new URL('../sidecar/launch.cjs', import.meta.url), join(dir, 'launch.cjs'));
    mkdirSync(join(dir, 'apps', 'node', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'node', 'package.json'), '{"type":"module"}');
    writeFileSync(
        join(dir, 'apps', 'node', 'dist', 'main.js'),
        `console.log('args ' + process.argv.slice(2).join(' '));
setTimeout(() => {
    console.log('listening');
    process.once('SIGTERM', async () => {
        await new Promise((done) => setTimeout(done, 50));
        console.log('drained');
        process.exit(0);
    });
}, ${listenAfterMs});
`
    );
    return join(dir, 'launch.cjs');
}

function launch(launcher, until) {
    const child = spawn(process.execPath, [launcher, 'start', '--no-open'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return new Promise((resolve) => {
        child.stdout.on('data', (chunk) => {
            out += chunk;
            if (out.includes(until)) resolve({ child, exited, output: () => out });
        });
    });
}

test("closing stdin is the node's SIGTERM shutdown", async () => {
    const { child, exited, output } = await launch(fakeNode(), 'listening');
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.match(output(), /args start --no-open/);
    assert.match(output(), /drained/);
});

test('a stop while the node is still starting waits for its handler', async () => {
    const { child, exited, output } = await launch(fakeNode({ listenAfterMs: 500 }), 'args');
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.match(output(), /listening[\s\S]*drained/);
});
