import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicKeyLink, devLoginLink, ensureDevVars, githubLoginConfigured, needsBuild, newestMtimeMs, parseArgs, parseDevVars, pnpmCommand, renderDevVars, wranglerDevArgs } from './dev.mjs';

// A deterministic "random": a counter from `seed`, so every draw is fixed for the seed and distinct from the last.
const fakeRandom = (seed) => {
    let next = seed;
    return (n) => Buffer.from(Array.from({ length: n }, () => next++ & 0xff));
};

test('renderDevVars: three long-enough random secrets and no Anthropic key (#231)', () => {
    const { text, vars } = renderDevVars({ random: fakeRandom(7) });
    const parsed = parseDevVars(text);
    assert.deepEqual(parsed, vars);
    assert.deepEqual(Object.keys(parsed).sort(), ['AGENTIC_DEV_LOGIN', 'SESSION_SECRET', 'WORKSPACE_KEK']);
    assert.ok(parsed.SESSION_SECRET.length >= 32, 'SESSION_SECRET ≥ 32 chars');
    assert.ok(parsed.AGENTIC_DEV_LOGIN.length >= 16, 'AGENTIC_DEV_LOGIN ≥ 16 chars');
    assert.equal(Buffer.from(parsed.WORKSPACE_KEK, 'base64').length, 32, 'WORKSPACE_KEK is base64 of 32 bytes');
    assert.match(parsed.SESSION_SECRET, /^[A-Za-z0-9_-]+$/, 'URL-safe, so the link needs no escaping');
    assert.match(parsed.AGENTIC_DEV_LOGIN, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(parsed.SESSION_SECRET.slice(0, 16), parsed.AGENTIC_DEV_LOGIN.slice(0, 16), 'secrets are drawn separately');
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY/, 'not even as a placeholder: the key is a workspace secret now');
    assert.match(text, /\/plugins\/anthropic-api/, 'the file says where the key goes instead');
    // Reproducible for the same random source: the file is a pure function of it.
    assert.equal(renderDevVars({ random: fakeRandom(7) }).text, text);
});

test('anthropicKeyLink: the anthropic-api plugin page on the dev port', () => {
    assert.equal(anthropicKeyLink(), 'http://localhost:8787/plugins/anthropic-api');
    assert.equal(anthropicKeyLink(9000), 'http://localhost:9000/plugins/anthropic-api');
});

test('parseDevVars: comments, blanks, quotes and CRLF', () => {
    assert.deepEqual(parseDevVars('# c\r\n\r\nA=1\r\nB="two words"\r\nC=\'x=y\'\r\nnot a line\r\n=nokey\r\n  D = spaced \r\n'), { A: '1', B: 'two words', C: 'x=y', D: 'spaced' });
});

test('ensureDevVars: creates the file once (0600 where it applies), then only reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-dev-vars-'));
    try {
        const file = join(dir, 'web', '.dev.vars');
        // An env key is never copied in any more (#231) — only noticed, so the log can say it is ignored.
        const first = ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk-ant-env' }, { random: fakeRandom(1) });
        assert.equal(first.created, true);
        assert.equal(first.legacyAnthropicKey, 'env');
        assert.ok(existsSync(file));
        const written = readFileSync(file, 'utf8');
        assert.deepEqual(parseDevVars(written), first.vars);
        assert.doesNotMatch(written, /sk-ant-env/);

        // Second run: the file wins and is not touched.
        const again = ensureDevVars(file, {}, { random: fakeRandom(2) });
        assert.equal(again.created, false);
        assert.equal(again.legacyAnthropicKey, undefined);
        assert.equal(ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk' }).legacyAnthropicKey, 'env', 'only the shell has it: nothing in the file to delete');
        assert.deepEqual(again.vars, first.vars);
        assert.equal(readFileSync(file, 'utf8'), written);

        // A file from before #231 that still carries the key: read as it is (its WORKSPACE_KEK sealed the Registry's secrets), never rewritten, flagged.
        const legacy = 'SESSION_SECRET=x\nWORKSPACE_KEK=k\nANTHROPIC_API_KEY=sk-ant-old\n';
        writeFileSync(file, legacy);
        const old = ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk' });
        assert.equal(old.legacyAnthropicKey, 'file', 'the file wins: its line is the one to delete');
        assert.equal(old.vars.WORKSPACE_KEK, 'k');
        assert.equal(readFileSync(file, 'utf8'), legacy);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('devLoginLink: the secret rides ?token= on localhost, URL-encoded; without one, the bare form', () => {
    assert.equal(devLoginLink({ AGENTIC_DEV_LOGIN: 'abc def+/' }), 'http://localhost:8787/auth/dev-login?token=abc%20def%2B%2F');
    assert.equal(devLoginLink({ AGENTIC_DEV_LOGIN: 'tok' }, 9000), 'http://localhost:9000/auth/dev-login?token=tok');
    assert.equal(devLoginLink({}), 'http://localhost:8787/auth/dev-login');
});

test('needsBuild: missing dist, stale dist, fresh dist — by mtime, skipping node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-dev-build-'));
    try {
        const dist = join(dir, 'dist');
        const src = join(dir, 'src');
        const pkg = join(dir, 'packages', 'core', 'src');
        mkdirSync(src, { recursive: true });
        mkdirSync(pkg, { recursive: true });
        const t = (s) => new Date(1_700_000_000_000 + s * 1000);
        const touch = (file, when) => {
            mkdirSync(join(file, '..'), { recursive: true });
            writeFileSync(file, '');
            utimesSync(file, when, when);
        };
        touch(join(src, 'a.ts'), t(10));
        touch(join(pkg, 'index.ts'), t(20));

        // No dist at all.
        assert.equal(needsBuild({ distDir: dist, sources: [src, pkg] }).build, true);
        // A dist without the entry counts as missing.
        touch(join(dist, 'client', 'index.html'), t(100));
        assert.equal(needsBuild({ distDir: dist, sources: [src, pkg] }).build, true);
        // Built after every source: fresh.
        touch(join(dist, 'server', 'entry.cloudflare.js'), t(30));
        assert.deepEqual(needsBuild({ distDir: dist, sources: [src, pkg] }), { build: false, reason: 'dist is newer than every source file' });
        // A source edited after the build: stale, and the reason names the tree.
        touch(join(pkg, 'later.ts'), t(200));
        const stale = needsBuild({ distDir: dist, sources: [src, pkg] });
        assert.equal(stale.build, true);
        assert.match(stale.reason, /changed after the last build/);
        // A newer file under node_modules is not a source change.
        touch(join(pkg, 'later.ts'), t(25));
        touch(join(src, 'node_modules', 'dep', 'x.js'), t(500));
        assert.equal(needsBuild({ distDir: dist, sources: [src, pkg] }).build, false);
        assert.equal(newestMtimeMs(join(dir, 'nope')), 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('parseArgs: the flags, --port both ways, errors for the rest', () => {
    assert.deepEqual(parseArgs([]), { rebuild: false, mock: false, help: false, port: 8787 });
    assert.deepEqual(parseArgs(['--rebuild', '--port', '9000']), { rebuild: true, mock: false, help: false, port: 9000 });
    assert.equal(parseArgs(['--port=8788']).port, 8788);
    assert.equal(parseArgs(['--mock']).mock, true);
    assert.throws(() => parseArgs(['--port', 'x']), /--port needs a positive integer/);
    assert.throws(() => parseArgs(['--watch']), /unknown argument '--watch'/);
});

test('pnpmCommand: through the running pnpm (a JS entry) without a shell, else pnpm via the shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-dev-pnpm-'));
    try {
        const entry = join(dir, 'pnpm.cjs');
        writeFileSync(entry, '');
        const viaNode = pnpmCommand(['build'], { npm_execpath: entry });
        assert.equal(viaNode.file, process.execPath);
        assert.deepEqual(viaNode.args, [entry, 'build']);
        assert.equal(viaNode.shell, false);
        // npm's own entry (`npm-cli.js`) or none: fall back to the shell resolving `pnpm` / `pnpm.cmd`.
        assert.deepEqual(pnpmCommand(['build'], {}), { file: 'pnpm', args: ['build'], shell: true });
        assert.deepEqual(pnpmCommand(['build'], { npm_execpath: join(dir, 'missing.cjs') }), { file: 'pnpm', args: ['build'], shell: true });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('githubLoginConfigured: both OAuth secrets, nothing else (#180)', () => {
    assert.equal(githubLoginConfigured({}), false);
    assert.equal(githubLoginConfigured({ GITHUB_CLIENT_ID: 'cid' }), false);
    assert.equal(githubLoginConfigured({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec' }), true);
    assert.equal(githubLoginConfigured(renderDevVars({ random: (n) => Buffer.alloc(n, 1) }).vars), false);
});

test('wranglerDevArgs: APP_ORIGIN pinned to localhost on the dev port, --port only when it is not the default', () => {
    assert.deepEqual(wranglerDevArgs(), ['dev', '--var', 'APP_ORIGIN:http://localhost:8787']);
    assert.deepEqual(wranglerDevArgs(8787), ['dev', '--var', 'APP_ORIGIN:http://localhost:8787']);
    assert.deepEqual(wranglerDevArgs(9000), ['dev', '--var', 'APP_ORIGIN:http://localhost:9000', '--port', '9000']);
});
