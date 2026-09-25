#!/usr/bin/env node
// The build config a release merges over tauri.conf.json (`tauri build --config <file>`, #848):
// the version from the tag, and — only when the repo has an updater key — the updater's
// public key and endpoint plus signed updater artifacts. Nothing here is specific to one
// deployment: the workflow passes what the repo's variables say.
//
//   node scripts/release-config.mjs desktop-v1.2.3 > src-tauri/release.conf.json
//
// Env: AGENTIC_UPDATER_PUBKEY (the minisign public key, `tauri signer generate`), AGENTIC_UPDATER_URL
// (where latest.json is served). Without the key the build has no updater and never checks.

export function versionOf(tag) {
    const m = /^desktop-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? '');
    if (!m) throw new Error(`"${tag}" is not desktop-v<semver>`);
    return m[1];
}

export function releaseConfig(tag, env = {}) {
    const config = { version: versionOf(tag) };
    const pubkey = (env.AGENTIC_UPDATER_PUBKEY ?? '').trim();
    const url = (env.AGENTIC_UPDATER_URL ?? '').trim();
    if (pubkey) {
        if (!url.startsWith('https://')) throw new Error('AGENTIC_UPDATER_URL must be an https URL when AGENTIC_UPDATER_PUBKEY is set');
        config.bundle = { createUpdaterArtifacts: true };
        config.plugins = { updater: { pubkey, endpoints: [url] } };
    }
    return config;
}

if (process.argv[1]?.endsWith('release-config.mjs')) {
    try {
        process.stdout.write(`${JSON.stringify(releaseConfig(process.argv[2], process.env), null, 2)}\n`);
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}
