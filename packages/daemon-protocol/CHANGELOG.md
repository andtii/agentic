# Changelog

All notable changes to `@agentic/daemon-protocol` (Keep a Changelog, semver).

## [Unreleased]

- `quota { environmentId, snapshot: QuotaSnapshot }` (daemon → platform, #267, part of #261): an environment's provider limits, pushed unsolicited. Schemas `quotaWindow`, `quotaSnapshot` (`utilization` 0..1 or `null`, `resetsAt` an ISO date-time) and `quotaFrame` — the snapshot must name the frame's environment; alias `QuotaFrame`. The conformance suite passes over `quota` frames wherever it passes over heartbeats, and the in-memory daemon sends one (`not-reported`) after `welcome`.
- Web-managed environment frames (#236, part of #224; decisions 2026-09-19 (c)):
  - `env.request { requestId, op: 'put', environment } | { requestId, op: 'remove', environmentId }` (platform → daemon) and `env.response { requestId, exactly one of result: { environmentId } | error }` (daemon → platform); aliases `EnvRequestFrame` / `EnvResponseFrame`.
  - Schemas `environmentInput`, `envResult`, `envError`, `machinePolicy`, `envRequestFrame`, `envResponseFrame`. `environmentInput` is **strict**: an input carrying `profileDir` (or any key the contract does not name) fails the frame instead of being stripped. It needs at least one working root and a `concurrency` of 1 or more.
  - `hello` and `env` accept the optional `policy: { webManaged, allowedRoots }`.
  - `daemonConformance` gains `env-put`, `env-remove` and `env-policy`, gated on the new `env-manage` harness feature. Such a harness starts web-managed with an allowed root that exists, and implements `ConformanceDaemon.setPolicy`. A harness without the feature skips them, so a daemon that cannot answer `env.request` yet still passes.
  - `inMemoryHarness` answers `env.request` under its `policy` option (default: web-managed inside `/work`). Its `acceptAnyRoot`, `removeInUse` and `ignorePolicy` faults prove the cases catch a daemon that ignores the policy.
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
