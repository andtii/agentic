/**
 * Version helpers the daemon and the platform share (#360; OPS-05): how two
 * daemon versions order, which release asset a build takes, and whether an
 * asset is one a daemon may download. No dependency: semver is small enough
 * to write out.
 */

import type { ReleaseAsset } from '@agentic/core';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const DIGITS = /^\d+$/;

/** A SHA-256 digest as a release manifest carries it: 64 hex characters. */
export const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Two digit strings without leading zeros, numerically — no overflow however long. */
const compareDigits = (a: string, b: string): number => sign(a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/** Semver §11: numeric identifiers numerically and below alphanumeric ones, those in ASCII order, a shorter list first. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const x = a[i]!;
        const y = b[i]!;
        const xn = DIGITS.test(x);
        const yn = DIGITS.test(y);
        const c = xn && yn ? compareDigits(x, y) : xn ? -1 : yn ? 1 : x < y ? -1 : x > y ? 1 : 0;
        if (c) return c;
    }
    return sign(a.length - b.length);
}

/**
 * Order two versions by semver precedence: negative when `a` is older, 0 when they rank the same, positive when `a` is
 * newer. A build off `main` (`0.2.0-main.<commit unix seconds>.<sha7>`, #437) is a prerelease, so it orders below `0.2.0`
 * and above `0.1.9`, and two of them by their numeric commit time, never by the sha; build
 * metadata (`+…`) is ignored. A malformed version orders below every valid one (two malformed ones compare as strings,
 * so a sort stays stable).
 */
export function compareVersions(a: string, b: string): number {
    const x = SEMVER.exec(a);
    const y = SEMVER.exec(b);
    if (!x || !y) return x ? 1 : y ? -1 : a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i++) {
        const c = compareDigits(x[i]!, y[i]!);
        if (c) return c;
    }
    if (x[4] === undefined || y[4] === undefined) return x[4] === y[4] ? 0 : x[4] === undefined ? 1 : -1;
    return comparePrerelease(x[4].split('.'), y[4].split('.'));
}

/** Whether `version` is a semver version `compareVersions` can order. */
export const isVersion = (version: string): boolean => SEMVER.test(version);

/**
 * The release asset key of a build, `<platform>-<arch>` in Node's own names (`process.platform`, `process.arch`):
 * `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. `DaemonBuild.platform` carries it and a
 * `ReleaseManifest` keys its assets by it.
 */
export function platformKey(platform: string, arch: string): string {
    return `${platform}-${arch}`;
}

/** Whether `url` parses as an `https:` URL. */
export function isHttpsUrl(url: string): boolean {
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

/** An asset a daemon may fetch: an `https:` URL, a 64-hex SHA-256, a whole byte count and a version. */
export function isHttpsAsset(asset: unknown): asset is ReleaseAsset {
    if (typeof asset !== 'object' || asset === null) return false;
    const a = asset as Record<string, unknown>;
    return (
        typeof a.url === 'string' &&
        isHttpsUrl(a.url) &&
        typeof a.sha256 === 'string' &&
        SHA256_HEX.test(a.sha256) &&
        typeof a.bytes === 'number' &&
        Number.isSafeInteger(a.bytes) &&
        a.bytes > 0 &&
        typeof a.version === 'string' &&
        a.version.length > 0
    );
}
