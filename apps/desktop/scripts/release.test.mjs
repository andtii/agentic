import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { msiVersionOf, releaseConfig, versionOf } from './release-config.mjs';
import { budgetOf, installers, overBudget } from './check-size.mjs';

test('the version comes from the tag', () => {
    assert.equal(versionOf('desktop-v1.2.3'), '1.2.3');
    assert.equal(versionOf('desktop-v1.2.3-rc.1'), '1.2.3-rc.1');
    assert.throws(() => versionOf('daemon-v1.2.3'));
    assert.throws(() => versionOf('desktop-v1.2'));
    assert.throws(() => versionOf(undefined));
});

test('the MSI gets a numeric version', () => {
    assert.equal(msiVersionOf('1.2.3-rc.4'), '1.2.3.4');
    assert.equal(msiVersionOf('1.2.3-alpha-beta.4'), '1.2.3.4');
    // Every rc sorts below the release it leads to.
    assert.equal(msiVersionOf('1.2.3'), '1.2.3.65535');
    assert.throws(() => msiVersionOf('0.1.0-beta'), /must end in a number/);
    assert.throws(() => msiVersionOf('1.0.0-rc.0'));
    assert.throws(() => msiVersionOf('1.0.0-rc.65535'));
});

test('no key, no updater', () => {
    assert.deepEqual(releaseConfig('desktop-v1.0.0-rc.2', {}), { version: '1.0.0-rc.2', bundle: { windows: { wix: { version: '1.0.0.2' } } } });
});

test('a key turns on signed updater artifacts and the endpoint', () => {
    const c = releaseConfig('desktop-v1.0.0', { AGENTIC_UPDATER_PUBKEY: 'KEY', AGENTIC_UPDATER_URL: 'https://example.com/latest.json' });
    assert.deepEqual(c, { version: '1.0.0', bundle: { windows: { wix: { version: '1.0.0.65535' } }, createUpdaterArtifacts: true }, plugins: { updater: { pubkey: 'KEY', endpoints: ['https://example.com/latest.json'] } } });
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

test('an AppImage has its own budget; everything else keeps the shell budget', () => {
    assert.equal(budgetOf('/x/bundle/appimage/Agentic_1_amd64.AppImage', 15), 100);
    assert.equal(budgetOf('/x/bundle/deb/Agentic_1_amd64.deb', 15), 15);
    const mb = 1024 * 1024;
    const files = [{ path: '/b/bundle/appimage/A.AppImage', bytes: 78 * mb }, { path: '/b/bundle/deb/A.deb', bytes: 3 * mb }, { path: '/b/bundle/msi/A.msi', bytes: 16 * mb }];
    assert.deepEqual(overBudget(files, 15).map((f) => f.path), ['/b/bundle/msi/A.msi']);
});
