# Changelog

All notable changes to `@agentic/daemon-protocol` (Keep a Changelog, semver).

## [Unreleased]

- `DaemonFrame` / `PlatformFrame` instantiated with the `@sigx/ai-agent/wire` envelope, plus per-kind aliases (`HelloFrame`, `SessionFrameFrame`, …).
- Standard Schema (zod) validators for every frame kind (`daemonFrameSchemas`, `platformFrameSchemas`, the unions, the wire and common pieces) with `LIMITS` on frame size, strings and lists.
- JSON-over-WebSocket framing: `encodeFrame`, `decodeDaemonFrame` / `decodePlatformFrame` (string or binary), `parseDaemonFrame` / `parsePlatformFrame`, `DaemonProtocolError`, and the named codes `too-large` · `not-json` · `not-object` · `unsupported-version` · `unknown-type` · `invalid`.
- `./testing`: `daemonConformance(harness)` (hello/welcome, malformed input, env, heartbeat, session, reconnect replay, gap, tool round trip) and `inMemoryHarness()`, the reference daemon over an in-memory link with `faults` for negative tests.
- Package skeleton.
