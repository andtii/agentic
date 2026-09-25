import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseConfig, versionOf } from './release-config.mjs';
import { installers, overBudget } from './check-size.mjs';

test('the version comes from the tag', () => {
    assert.equal(versionOf('desktop-v1.2.3'), '1.2.3');
    assert.equal(versionOf('desktop-v1.2.3-rc.1'), '1.2.3-rc.1');
    assert.throws(() => versionOf('daemon-v1.2.3'));
    assert.throws(() => versionOf('desktop-v1.2'));
    assert.throws(() => versionOf(undefined));
});

test('no key, no updater', () => {
    assert.deepEqual(releaseConfig('desktop-v1.0.0', {}), { version: '1.0.0' });
});

test('a key turns on signed updater artifacts and the endpoint', () => {
    const c = releaseConfig('desktop-v1.0.0', { AGENTIC_UPDATER_PUBKEY: 'KEY', AGENTIC_UPDATER_URL: 'https://example.com/latest.json' });
    assert.deepEqual(c, { version: '1.0.0', bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: 'KEY', endpoints: ['https://example.com/latest.json'] } } });
    assert.throws(() => releaseConfig('desktop-v1.0.0', { AGENTIC_UPDATER_PUBKEY: 'KEY', AGENTIC_UPDATER_URL: 'http://example.com/x' }));
});

test('installers are measured, .app bundles are not walked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-size-'));
    mkdirSync(join(dir, 'bundle', 'dmg'), { recursive: true });
    mkdirSync(join(dir, 'bundle', 'macos', 'Agentic.app', 'Contents'), { recursive: true });
    writeFileSync(join(dir, 'bundle', 'dmg', 'Agentic.dmg'), Buffer.alloc(2048));
    writeFileSync(join(dir, 'bundle', 'macos', 'Agentic.app', 'Contents', 'x.exe'), Buffer.alloc(10));
    writeFileSync(join(dir, 'bundle', 'notes.txt'), 'x');
    mkdirSync(join(dir, 'release', 'deps'), { recursive: true });
    writeFileSync(join(dir, 'release', 'deps', 'build-script-build.exe'), Buffer.alloc(10));
    const files = installers(dir);
    assert.deepEqual(files.map((f) => f.path.split(/[\\/]/).pop()), ['Agentic.dmg']);
    assert.equal(overBudget(files, 1).length, 0);
    assert.equal(overBudget(files, 0.001).length, 1);
});
