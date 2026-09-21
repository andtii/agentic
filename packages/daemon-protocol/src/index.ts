/**
 * @agentic/daemon-protocol — the daemon <-> platform envelope, validated.
 *
 * The frame TYPES live in `@agentic/core` (`DaemonFrame<F, R>`,
 * `PlatformFrame<C>`, `DAEMON_PROTOCOL_VERSION`); this package instantiates
 * them with the `@sigx/ai-agent/wire` session envelope, validates every kind
 * with a Standard Schema (zod) and frames them as JSON-over-WebSocket text
 * messages with named error codes. The conformance suite both ends must
 * pass is on `./testing`. Edge-safe: no `node:` imports.
 */
export const PACKAGE = '@agentic/daemon-protocol';

export { DAEMON_PROTOCOL_VERSION, DAEMON_FRAME_TYPES, PLATFORM_FRAME_TYPES } from '@agentic/core';
export type { Cursor, OpenSpec, DaemonBuild, DaemonFeature, SessionClosedCode, ReleaseAsset, ReleaseManifest, HarnessReport, UpdatePhase, HarnessPhase, LoginPhase, MachinePolicyInput, MachinePolicyError, MachinePolicyOp, MachinePolicyResult, MachineListing } from '@agentic/core';

export type * from './frames.js';
export * from './schema/index.js';
export * from './framing/index.js';
export { compareVersions, isVersion, platformKey, isHttpsUrl, isHttpsAsset, SHA256_HEX } from './release.js';
export { SESSION_CLOSED_CODES, DAEMON_FEATURES, UPDATE_PHASES, HARNESS_PHASES, LOGIN_PHASES, DRAINING, drainingReply, isDrainingReply } from './lifecycle.js';
