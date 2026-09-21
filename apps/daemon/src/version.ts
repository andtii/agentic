// Stamped by the build (`vite.config.ts` → `scripts/lib/stamp.mjs`): on a `daemon-v<semver>` tag the tag's
// semver and channel `stable`, otherwise `<package.json version>-main.<commit unix seconds>.<sha7>` (`g<sha7>` for a digits-only sha7
// with a leading zero, which semver forbids) and channel `latest`.
// Run from source (vitest) nothing is stamped: `0.0.0-dev`, commit `unknown`, channel `dev`.
import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';

declare const __DAEMON_VERSION__: string | undefined;
declare const __DAEMON_COMMIT__: string | undefined;
declare const __DAEMON_CHANNEL__: string | undefined;

/** Reported in `hello.daemonVersion`. */
export const DAEMON_VERSION: string = typeof __DAEMON_VERSION__ !== 'undefined' ? __DAEMON_VERSION__ : '0.0.0-dev';
/** The commit built, seven hex digits (`unknown` unstamped). */
export const DAEMON_COMMIT: string = typeof __DAEMON_COMMIT__ !== 'undefined' ? __DAEMON_COMMIT__ : 'unknown';
/** The release channel the build belongs to: `stable` (a tag), `latest` (main) or `dev` (unstamped). */
export const DAEMON_CHANNEL: 'stable' | 'latest' | 'dev' = typeof __DAEMON_CHANNEL__ !== 'undefined' ? (__DAEMON_CHANNEL__ as 'stable' | 'latest') : 'dev';

/** What `agentic-daemon --version` prints: `agentic-daemon <version> (<commit>, protocol <n>, <channel>)`. */
export function versionLine(): string {
    return `agentic-daemon ${DAEMON_VERSION} (${DAEMON_COMMIT}, protocol ${DAEMON_PROTOCOL_VERSION}, ${DAEMON_CHANNEL})`;
}
