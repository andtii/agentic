# @agentic/daemon-protocol

Envelope validators and conformance suite for the daemon <-> platform WebSocket protocol (architecture §5b).

The frame TYPES live in `@agentic/core` (`DaemonFrame<F, R>`, `PlatformFrame<C>`, `Cursor`, `OpenSpec`, `DAEMON_PROTOCOL_VERSION`). This package instantiates them with the `@sigx/ai-agent/wire` session envelope (`WireFrame` / `WireReply` / `WireCommand`), validates every kind, and frames them as JSON-over-WebSocket text messages. Edge-safe: no `node:` imports, no `process` / `Buffer`.

## Frames

```ts
import type { DaemonFrame, PlatformFrame, HelloFrame, SessionFrameFrame } from '@agentic/daemon-protocol';
```

`DaemonFrame` (daemon → platform): `hello` · `env` · `heartbeat` · `session.opened` · `session.frame` · `session.reply` · `session.closed` · `tool.call` · `pong` · `fs.response`.
`PlatformFrame` (platform → daemon): `welcome` · `session.open` · `session.command` · `session.close` · `tool.result` · `ping` · `fs.request`.

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
| `tool-round-trip` | `tool.call` → `tool.result` (output, then error) and the turn completes both times |

```ts
import { daemonConformance, inMemoryHarness } from '@agentic/daemon-protocol/testing';

for (const c of daemonConformance(inMemoryHarness())) it.skipIf(!!c.skip)(c.name, c.run);
```

A harness implements `DaemonConformanceHarness`: `start(script)` returns a `ConformanceDaemon` (`machineId`, `environmentId`, `dial()` → a `PlatformSeat` with `send` / `next` / `drop`, `stop()`, and the optional `setEnvironments` / `truncateLog` behind `features`). `inMemoryHarness()` is the reference fake — also a stand-in daemon for tests of the platform side — and its `faults` option breaks it on purpose so a test can check the suite notices.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.
