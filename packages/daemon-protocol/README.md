# @agentic/daemon-protocol

Envelope validators and conformance suite for the daemon <-> platform WebSocket protocol (architecture §5b).

The frame TYPES live in `@agentic/core` (`DaemonFrame<F, R>`, `PlatformFrame<C>`, `Cursor`, `OpenSpec`, `DAEMON_PROTOCOL_VERSION`). This package instantiates them with the `@sigx/ai-agent/wire` session envelope (`WireFrame` / `WireReply` / `WireCommand`), validates every kind, and frames them as JSON-over-WebSocket text messages. Edge-safe: no `node:` imports, no `process` / `Buffer`.

## Frames

```ts
import type { DaemonFrame, PlatformFrame, HelloFrame, SessionFrameFrame } from '@agentic/daemon-protocol';
```

`DaemonFrame` (daemon → platform): `hello` · `env` · `heartbeat` · `session.opened` · `session.frame` · `session.reply` · `session.closed` · `tool.call` · `pong` · `fs.response` · `env.response` · `quota`.
`PlatformFrame` (platform → daemon): `welcome` · `session.open` · `session.command` · `session.close` · `tool.result` · `ping` · `fs.request` · `env.request`.

## Validators

One zod schema per frame kind, plus the unions. Every one is a [Standard Schema](https://standardschema.dev) (`schema['~standard'].validate(value)`), so a caller that does not want zod still gets a validator.

```ts
import { daemonFrameSchemas, platformFrame, helloFrame, LIMITS } from '@agentic/daemon-protocol';

helloFrame.safeParse(value);                 // one kind
daemonFrameSchemas['session.frame'];         // by `t`
platformFrame.safeParse(value);              // the union
```

`LIMITS` bounds every field: 1 MiB per frame, 256 chars per id/name, 4096 per reason/message/path, 512 KiB for `OpenSpec.system`, 4096 entries per list or record (cursors, `configure` patch keys). `tool.result` carries exactly one of `output` or `error` — a void tool sends `output: null`. Unknown keys are stripped, not refused (forward compatibility within a version).

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
| `reconnect-replay` | drop mid-turn, redial: `hello.resume` names the session, `welcome.wanted` drives a replay that starts right after the cursor — no duplicate, no hole (OPS-06) |
| `gap` | a `wanted` cursor older than the daemon's log yields a `gap` frame, not silence (OPS-04) — feature `gap` |
| `fs-list` | `fs.request` `list` of a working root names that root with no `parent` and only entries inside the roots; a sibling of the root answers `outside-roots` (OPS-01), an unknown environment `unknown-environment` — feature `fs` |
| `fs-locate` | `fs.request` `locate` of an origin nobody has answers an empty, untruncated `locate` result naming that origin; with the harness's `knownOrigin` every match lies inside the roots and carries the same origin (`sameOrigin`, #331); an unknown environment answers `unknown-environment` — feature `fs` |
| `env-put` | `env.request` `put` creates an environment inside `hello.policy.allowedRoots` and announces it with `env`; with an `id` it changes that one; a root outside the allowed roots answers `outside-allowed-roots`, an unknown runtime `unknown-runtime` (OPS-01) — feature `env-manage` |
| `env-remove` | `remove` refuses `in-use` while a session runs there, removes an idle environment, answers `unknown-environment` for one it does not have — feature `env-manage` |
| `env-policy` | a policy turned off on the machine (`setPolicy`) is announced with `env`, and every `env.request` then answers `policy-disabled` — feature `env-manage` |
| `tool-round-trip` | `tool.call` → `tool.result` (output, then error) and the turn completes both times |

```ts
import { daemonConformance, inMemoryHarness } from '@agentic/daemon-protocol/testing';

for (const c of daemonConformance(inMemoryHarness())) it.skipIf(!!c.skip)(c.name, c.run);
```

A harness implements `DaemonConformanceHarness`: `start(script)` returns a `ConformanceDaemon` (`machineId`, `environmentId`, `dial()` → a `PlatformSeat` with `send` / `next` / `drop`, `stop()`, and the optional `setEnvironments` / `truncateLog` / `setPolicy` behind `features`); an optional `knownOrigin` names a remote URL with a checkout under the suite environment's roots so `fs-locate` proves a match. `inMemoryHarness()` is the reference fake — also a stand-in daemon for tests of the platform side — its `repos` option fakes git checkouts (badged in listings, found by `locate`; the first with an `origin` becomes `knownOrigin`), and its `faults` option breaks it on purpose so a test can check the suite notices.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.
