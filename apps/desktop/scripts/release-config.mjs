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

/**
 * The MSI's version (`major.minor.patch.build`, numbers only), since MSI refuses a semver pre-release.
 * A pre-release's trailing number is the build (`1.2.3-rc.4` → `1.2.3.4`), and a stable release is the
 * highest build (`1.2.3` → `1.2.3.65535`), so every rc sorts below the release it leads to. A pre-release
 * without a trailing number would collide with its release, so it is refused: tag `-rc.N` / `-beta.N`.
 */
export const MSI_STABLE_BUILD = 65535;

export function msiVersionOf(version) {
    // Split at the first hyphen only: a pre-release may contain more (`1.2.3-alpha-beta.4`).
    const cut = version.indexOf('-');
    const core = cut < 0 ? version : version.slice(0, cut);
    const pre = cut < 0 ? '' : version.slice(cut + 1);
    if (!pre) return `${core}.${MSI_STABLE_BUILD}`;
    const m = /(\d+)$/.exec(pre);
    if (!m) throw new Error(`pre-release "${pre}" must end in a number (-rc.N) to get an MSI version`);
    const n = Number(m[1]);
    if (n < 1 || n >= MSI_STABLE_BUILD) throw new Error(`pre-release number ${n} must be 1..${MSI_STABLE_BUILD - 1} for an MSI version`);
    return `${core}.${n}`;
}

export function releaseConfig(tag, env = {}) {
    const version = versionOf(tag);
    const config = { version, bundle: { windows: { wix: { version: msiVersionOf(version) } } } };
    const pubkey = (env.AGENTIC_UPDATER_PUBKEY ?? '').trim();
    const url = (env.AGENTIC_UPDATER_URL ?? '').trim();
    if (pubkey) {
        if (!url.startsWith('https://')) throw new Error('AGENTIC_UPDATER_URL must be an https URL when AGENTIC_UPDATER_PUBKEY is set');
        config.bundle.createUpdaterArtifacts = true;
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
