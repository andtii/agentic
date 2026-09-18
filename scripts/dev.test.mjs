import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devLoginLink, ensureDevVars, githubLoginConfigured, needsBuild, newestMtimeMs, parseArgs, parseDevVars, pnpmCommand, renderDevVars } from './dev.mjs';

// A deterministic "random": a counter from `seed`, so every draw is fixed for the seed and distinct from the last.
const fakeRandom = (seed) => {
    let next = seed;
    return (n) => Buffer.from(Array.from({ length: n }, () => next++ & 0xff));
};

test('renderDevVars: three long-enough random secrets, the key from the env, the placeholder without', () => {
    const { text, vars, anthropic } = renderDevVars({ anthropicApiKey: 'sk-ant-test-123', random: fakeRandom(7) });
    const parsed = parseDevVars(text);
    assert.equal(anthropic, 'env');
    assert.deepEqual(parsed, vars);
    assert.ok(parsed.SESSION_SECRET.length >= 32, 'SESSION_SECRET ≥ 32 chars');
    assert.ok(parsed.AGENTIC_DEV_LOGIN.length >= 16, 'AGENTIC_DEV_LOGIN ≥ 16 chars');
    assert.equal(Buffer.from(parsed.WORKSPACE_KEK, 'base64').length, 32, 'WORKSPACE_KEK is base64 of 32 bytes');
    assert.equal(parsed.ANTHROPIC_API_KEY, 'sk-ant-test-123');
    assert.match(parsed.SESSION_SECRET, /^[A-Za-z0-9_-]+$/, 'URL-safe, so the link needs no escaping');
    assert.match(parsed.AGENTIC_DEV_LOGIN, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(parsed.SESSION_SECRET.slice(0, 16), parsed.AGENTIC_DEV_LOGIN.slice(0, 16), 'secrets are drawn separately');

    const without = renderDevVars({ random: fakeRandom(7) });
    assert.equal(without.anthropic, 'placeholder');
    assert.equal(parseDevVars(without.text).ANTHROPIC_API_KEY, undefined);
    assert.match(without.text, /^# ANTHROPIC_API_KEY=/m, 'a commented placeholder line to fill in');
    // Reproducible for the same random source: the file is a pure function of it and the key.
    assert.equal(renderDevVars({ random: fakeRandom(7) }).text, without.text);
});

test('parseDevVars: comments, blanks, quotes and CRLF', () => {
    assert.deepEqual(parseDevVars('# c\r\n\r\nA=1\r\nB="two words"\r\nC=\'x=y\'\r\nnot a line\r\n=nokey\r\n  D = spaced \r\n'), { A: '1', B: 'two words', C: 'x=y', D: 'spaced' });
});

test('ensureDevVars: creates the file once (0600 where it applies), then only reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-dev-vars-'));
    try {
        const file = join(dir, 'web', '.dev.vars');
        const first = ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk-ant-env' }, { random: fakeRandom(1) });
        assert.equal(first.created, true);
        assert.equal(first.anthropic, 'env');
        assert.ok(existsSync(file));
        const onDisk = parseDevVars(readFileSync(file, 'utf8'));
        assert.deepEqual(onDisk, first.vars);

        // Second run: the file wins; the env is not re-read into it.
        const again = ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk-ant-other' }, { random: fakeRandom(2) });
        assert.equal(again.created, false);
        assert.equal(again.anthropic, 'file');
        assert.deepEqual(again.vars, first.vars);
        assert.equal(readFileSync(file, 'utf8'), readFileSync(file, 'utf8'));

        // A file without the key: reports whether the env could have supplied it.
        writeFileSync(file, 'SESSION_SECRET=x\nAGENTIC_DEV_LOGIN=y\n');
        assert.equal(ensureDevVars(file, {}).anthropic, 'missing');
        assert.equal(ensureDevVars(file, { ANTHROPIC_API_KEY: 'sk' }).anthropic, 'env-only');
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
