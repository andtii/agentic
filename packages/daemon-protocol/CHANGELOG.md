# Changelog

All notable changes to `@agentic/daemon-protocol` (Keep a Changelog, semver).

## [Unreleased]

- Folder browsing frames (#187, part of #185):
  - `fs.request { requestId, environmentId, op: list | worktree }` (platform → daemon) and `fs.response { requestId, exactly one of result | error }` (daemon → platform).
  - `fsOp` / `fsResult` / `fsError` schemas; a listing holds at most `FS_LIST_MAX_ENTRIES` folders.
  - `daemonConformance` gains `fs-list`, gated on the new `fs` harness feature: listing a root yields that root with no `parent` and entries inside the roots; a sibling of the root answers `outside-roots`; an unknown environment answers `unknown-environment`.
  - `inMemoryHarness` answers `list` over an empty tree, and its `browseAnywhere` fault proves the case catches a daemon that ignores the roots.
- `environment` schema accepts the optional `doctor` verdict (`environmentVerdict`: `ok`, bounded `findings` with level / code / message / environmentIds, `checkedAt`) on `hello` / `env` (#43).
- `DaemonFrame` / `PlatformFrame` instantiated with the `@sigx/ai-agent/wire` envelope, plus per-kind aliases (`HelloFrame`, `SessionFrameFrame`, …).
- Standard Schema (zod) validators for every frame kind (`daemonFrameSchemas`, `platformFrameSchemas`, the unions, the wire and common pieces) with `LIMITS` on frame size, strings, lists and records (`configure` patch keys, the output spec `name`); `tool.result` requires exactly one of `output` / `error`.
- JSON-over-WebSocket framing: `encodeFrame`, `decodeDaemonFrame` / `decodePlatformFrame` (string or binary), `parseDaemonFrame` / `parsePlatformFrame`, `DaemonProtocolError`, and the named codes `too-large` · `not-json` · `not-object` · `unsupported-version` · `unknown-type` · `invalid`.
- `./testing`: `daemonConformance(harness)` (hello/welcome, malformed input, env, heartbeat, session, reconnect replay, gap, tool round trip) and `inMemoryHarness()`, the reference daemon over an in-memory link with `faults` for negative tests.
- Package skeleton.
