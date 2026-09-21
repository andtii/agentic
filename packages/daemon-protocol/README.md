# @agentic/daemon-protocol

Envelope validators and conformance suite for the daemon <-> platform WebSocket protocol (architecture §5b).

The frame TYPES live in `@agentic/core` (`DaemonFrame<F, R>`, `PlatformFrame<C>`, `Cursor`, `OpenSpec`, `DAEMON_PROTOCOL_VERSION`). This package instantiates them with the `@sigx/ai-agent/wire` session envelope (`WireFrame` / `WireReply` / `WireCommand`), validates every kind, and frames them as JSON-over-WebSocket text messages. Edge-safe: no `node:` imports, no `process` / `Buffer`.

## Frames

```ts
import type { DaemonFrame, PlatformFrame, HelloFrame, SessionFrameFrame } from '@agentic/daemon-protocol';
```

`DaemonFrame` (daemon → platform): `hello` · `env` · `heartbeat` · `session.opened` · `session.ref` · `session.title` · `session.frame` · `session.reply` · `session.closed` · `tool.call` · `pong` · `fs.response` · `env.response` · `quota` · `history.response` · `update.status` · `harness.status` · `harnesses` · `policy.response` · `log.response` · `login.status`.
`PlatformFrame` (platform → daemon): `welcome` · `session.open` · `session.command` · `session.close` · `tool.result` · `ping` · `fs.request` · `env.request` · `history.request` · `update.request` · `update.cancel` · `harness.request` · `policy.request` · `log.request` · `login.request` · `login.answer` · `login.cancel`.

## Validators

One zod schema per frame kind, plus the unions. Every one is a [Standard Schema](https://standardschema.dev) (`schema['~standard'].validate(value)`), so a caller that does not want zod still gets a validator.

```ts
import { daemonFrameSchemas, platformFrame, helloFrame, LIMITS } from '@agentic/daemon-protocol';

helloFrame.safeParse(value);                 // one kind
daemonFrameSchemas['session.frame'];         // by `t`
platformFrame.safeParse(value);              // the union
```

`LIMITS` bounds every field: 1 MiB per frame, 256 chars per id/name, 4096 per reason/message/path, 512 KiB for `OpenSpec.system`, 4096 entries per list or record (cursors, `configure` patch keys). `tool.result` carries exactly one of `output` or `error` — a void tool sends `output: null`. Unknown keys are stripped, not refused (forward compatibility within a version).

The lifecycle frames (#359, #360) are bounded the same way: at most `LIMITS.harnesses` (16) harnesses, an update or harness `target` a strict `ReleaseAsset` (`https:` URL, 64-hex `sha256`, whole non-zero `bytes`) or, for an update, `'previous'` or `'restart'` (#355: the same build again, nothing downloaded), `drainTimeoutMs` at most `LIMITS.drainTimeoutMs` (a day), `error` on a status exactly when it is `failed`. A `hello.features` entry this end does not know is dropped rather than failing the `hello`.

The machine-managed-from-the-web frames (#355; features `policy`, `log`, `login`): `policy.request { op: 'set', policy: { allowedRoots } }` is strict and names at most `LIMITS.policyRoots` (32) folders — `~` forms included, which the machine expands — and `op: 'browse', path?` lists one folder's subfolders (or the machine's roots); `policy.response` is exactly one of `result: { policy }` (the policy as applied: `source: 'web'`, `requested` echoing the input, `locked` when the owner locked it on the machine), `result: { listing }` (≤ `FS_LIST_MAX_ENTRIES`, folders only) or a named `error` (`policy-locked`, `invalid`, `not-found`, `not-a-directory`, `remote-path`, `protected`, `io`, `unsupported`; `timeout` is the platform's). `log.request { lines }` asks for 1..`LIMITS.logLines` (500) and `log.response` carries at most that many, or `no-log` / `io` / `unsupported`. `login.request { environmentId }` starts a relayed sign-in; `login.status` passes `started` → `action` (with the `action` exactly then: `open-url` or `device-code`, `expectsPaste`) → `waiting` → `done` | `failed` (with `error` exactly then: `busy`, `unknown-environment`, `unsupported`, `cancelled`, `timeout`, `failed`); `login.answer { text }` is at most `LIMITS.loginAnswer` (2 KiB) and nothing else; `login.cancel` ends one. `env.request { op: 'put' }` may now carry `allowBypassPermissions`; `profileDir` is still refused.

## Versions and lifecycle reasons

```ts
import { compareVersions, platformKey, isHttpsAsset, SESSION_CLOSED_CODES, drainingReply, isDrainingReply } from '@agentic/daemon-protocol';

compareVersions('0.2.0', '0.2.0-main.1790000000.abc1234');  // > 0 — a main build orders below its release, above 0.1.9
compareVersions('0.2.0-main.1790000100.0f1e2d3', '0.2.0-main.1790000000.abc1234');  // > 0 — main builds order by commit time (#437); malformed input orders lowest
platformKey(process.platform, process.arch);     // 'win32-x64' — the release asset key `DaemonBuild.platform` carries
isHttpsAsset(asset);                             // an https URL, a 64-hex sha256, bytes and a version
```

`SESSION_CLOSED_CODES`, `DAEMON_FEATURES`, `UPDATE_PHASES` and `HARNESS_PHASES` list the named values. A draining daemon refuses a turn-starting `prompt` with `drainingReply(commandId)`: the session wire's error codes have no `draining`, so it is `code: 'busy'` — the platform parks it like `busy` — with a message starting `draining:` (`DRAINING`), which `isDrainingReply` recognises.

## Framing

```ts
import { encodeFrame, decodeDaemonFrame, decodePlatformFrame, parseDaemonFrame, DaemonProtocolError } from '@agentic/daemon-protocol';

socket.send(encodeFrame({ v: 1, t: 'ping' }));        // throws DaemonProtocolError('too-large') rather than send what the peer drops

const result = decodePlatformFrame(event.data);       // string | ArrayBuffer | ArrayBufferView
if (!result.ok) log(result.error.code, result.error.message, result.error.issues);
else handle(result.frame);
```

Refusals are checked in order and named: `too-large` (before parsing) · `not-json` · `not-object` · `unsupported-version` (a peer on another `v`, told so by name rather than by a pile of field errors) · `unknown-type` · `invalid` (with `issues: [{ path, message }]`). `parse*Frame` validates already-parsed JSON.

## Conformance (`./testing`)

`daemonConformance(harness)` is the suite every daemon must pass and the behaviour every platform side may rely on. The suite sits in the PLATFORM seat and drives a daemon whose runtime the harness scripts:

| Case | What it checks |
|---|---|
| `hello-welcome` | first frame is `hello` for the paired machine (USR-04), `welcome` answered, `ping` → `pong` |
| `malformed-input` | non-JSON, non-object, unknown-type, invalid, oversized and other-version frames are dropped, never answered; the connection survives |
| `env` | `setEnvironments` → `env` with auth status per environment (EXE-06/08) — feature `env` |
| `heartbeat` | heartbeats at the scripted interval; `active` lists open sessions (EXE-08) |
| `session` | `session.open` → `session.opened`; `prompt` → `ack` → N gapless `event` frames ending in `turn-end`; `session.close` → `session.closed` |
| `session-ref` | after the first prompt the daemon reports the runtime's own session id with `session.ref`, an id other than the placeholder `session.opened` carried (#388) — feature `session-ref` |
| `reconnect-replay` | drop mid-turn, redial: `hello.resume` names the session, `welcome.wanted` drives a replay that starts right after the cursor — no duplicate, no hole (OPS-06) |
| `gap` | a `wanted` cursor older than the daemon's log yields a `gap` frame, not silence (OPS-04) — feature `gap` |
| `fs-list` | `fs.request` `list` of a working root names that root with no `parent` and only entries inside the roots; a sibling of the root answers `outside-roots` (OPS-01), an unknown environment `unknown-environment` — feature `fs` |
| `fs-locate` | `fs.request` `locate` of an origin nobody has answers an empty, untruncated `locate` result naming that origin; with the harness's `knownOrigin` every match lies inside the roots and carries the same origin (`sameOrigin`, #331); an unknown environment answers `unknown-environment` — feature `fs` |
| `env-put` | `env.request` `put` creates an environment inside `hello.policy.allowedRoots` and announces it with `env`; with an `id` it changes that one; a root outside the allowed roots answers `outside-allowed-roots`, an unknown runtime `unknown-runtime` (OPS-01) — feature `env-manage` |
| `env-remove` | `remove` refuses `in-use` while a session runs there, removes an idle environment, answers `unknown-environment` for one it does not have — feature `env-manage` |
| `env-policy` | a policy turned off on the machine (`setPolicy`) is announced with `env`, and every `env.request` then answers `policy-disabled` — feature `env-manage` |
| `tool-round-trip` | `tool.call` → `tool.result` (output, then error) and the turn completes both times |
| `hello-build` | `hello.build` is a semver version equal to `daemonVersion`, the protocol spoken and a `<platform>-<arch>` key; `hello.features` lists what the harness declared; a `welcome` carrying `platform` keeps the socket — feature `build` |
| `session-reopen` | after `restart()` a `wanted` session the daemon lost is answered `session.closed { code: 'restart' }`, and a `session.open` with `spec.resume` re-opens it on a higher epoch whose turn streams whole (#363) — feature `resume` |
| `update-drain` | `update.request { mode: 'drain' }` with a turn running: phases in order, a `session.open` still accepted, its first `prompt` refused `draining`, the running turn finishes, then `restarting` and `session.closed { code: 'update' }` for every live session — feature `update` |
| `update-cancel` | `update.cancel` while draining answers `failed { code: 'cancelled' }`; nothing restarts and new turns are accepted again — feature `update` |
| `harness-install` | `harness.request { op: 'install' }` of the harness's `harnessTarget`: `harness.status` phases in order to `done`, and a `harnesses` frame with the new version `ready` — feature `harness` |
| `harness-remove-in-use` | removing the runtime an environment uses answers `failed { code: 'in-use' }`, even with `mode: 'now'`, and its session still runs — feature `harness` |
| `policy-set` | `policy.request { op: 'set' }` with `~` and an existing root: applied with `source: 'web'`, `requested` echoed, `~` expanded on the machine to a real folder, announced with `env`, and `policyConverged` holds; the harness's `protectedFolder` refuses `protected`, a missing folder `not-found`, a relative root `invalid`, each with nothing announced; an empty set turns web management off; the roots are put back (#355) — feature `policy` |
| `policy-locked` | after `lock(true)` (announced with `env`, `locked: true`, no root changed) a set answers `policy-locked` and announces nothing; after `lock(false)` a set is applied again — feature `policy` |
| `policy-browse` | `browse` without a path lists the machine's roots (no `path`, no `parent`); an allowed root lists its subfolders, none hidden, each below it; the `protectedFolder` is never listed beside its siblings; a missing folder is `not-found`, a relative path `invalid` — feature `policy` |
| `log-tail` | `log.request` answers at most `LIMITS.logLines` and at least what the harness said its log holds; asking for fewer gives exactly that many, `truncated`, and the END of the log — feature `log` |
| `login-relay` | `login.request` for the suite environment: phases in order, the `action` the harness announced (`loginAction`), a paste answered with `loginAnswer` when expected, `done`, then an `env` frame reporting the account `ok`; a second sign-in is `login.cancel`led to `failed { cancelled }`; an environment the machine lacks fails `unknown-environment` — feature `login` |
| `restart` | `update.request { target: 'restart', mode: 'drain' }` with a turn running: no `downloading` / `verifying` / `staged` phase, the running turn finishes, then `restarting` and `session.closed { code: 'restart' }` — feature `restart` |
| `history` | `history.request` answers the same event frames the session streamed, from `from` (exclusive) up to an inclusive `to`; `limit` cuts and says `more`, and asking again from the last frame continues without a duplicate or a hole; an unknown session answers `unknown-session`; after `truncateLog` a range the log no longer reaches answers a `gap` naming `earliest`, a range inside what is left is still answered (#397, OPS-04) — feature `history` |

```ts
import { daemonConformance, inMemoryHarness } from '@agentic/daemon-protocol/testing';

for (const c of daemonConformance(inMemoryHarness())) it.skipIf(!!c.skip)(c.name, c.run);
```

A harness implements `DaemonConformanceHarness`: `start(script)` returns a `ConformanceDaemon` (`machineId`, `environmentId`, `dial()` → a `PlatformSeat` with `send` / `next` / `drop`, `stop()`, and the optional `setEnvironments` / `truncateLog` / `setPolicy` / `lock` / `restart` behind `features`); an optional `knownOrigin` names a remote URL with a checkout under the suite environment's roots so `fs-locate` proves a match, `updateTarget` / `harnessTarget` name what `update` / `harness` install, and for #355 `protectedFolder` (a folder of the daemon's own that `policy` must refuse and never list), `logLines` (how many lines the `log` holds) and `loginAction` / `loginAnswer` (what the `login` relay will show, and the paste that completes it). `inMemoryHarness()` is the reference fake — also a stand-in daemon for tests of the platform side: it answers `history.request` from the per-session log it keeps, reports `IN_MEMORY_BUILD`, fakes an update (phases a tick apart, a drain that waits for running turns) and harness installs without downloading anything, and `restart()`s keeping its logs so a `wanted` session is answered `restart` and re-opened from `spec.resume` (#363) — its `repos` option fakes git checkouts (badged in listings, found by `locate`; the first with an `origin` becomes `knownOrigin`), its `log` and `login` options script the log it tails and the sign-in it relays (#355; it takes a web policy with `~` expanded to `IN_MEMORY_HOME`, refuses `IN_MEMORY_OWN_DIR`, and `lock()`s), and its `faults` option breaks it on purpose so a test can check the suite notices.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.
