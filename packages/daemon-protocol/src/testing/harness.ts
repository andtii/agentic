/**
 * What `daemonConformance` needs from the thing under test. The suite sits
 * in the PLATFORM seat of the socket and drives a daemon whose runtime is
 * scripted: the harness builds that daemon (a real `agentic-daemon` over a
 * `mockAgent`, or the in-memory fake in `./in-memory`) and hands the suite
 * one end of each connection. Transport is the harness's business — an
 * in-memory queue, a WebSocket pair, a relay.
 */

import type { Cursor, EnvironmentDescriptor, EnvironmentId, MachineId, SessionId } from '@agentic/core';
import type { PlatformFrame } from '../frames.js';

/** What the scripted runtime behind the daemon must do. */
export interface ConformanceScript {
    /**
     * Session event frames the runtime emits per `prompt` — including the final
     * `turn-end`, which is always the last one. Each becomes one `session.frame`
     * carrying an `event` wire frame with a gapless `seq`.
     */
    readonly events: number;
    /** A client tool the runtime calls once per prompt, before its events; the daemon bridges it as `tool.call` and waits for `tool.result`. */
    readonly tool?: { readonly name: string; readonly input: unknown };
    /** Heartbeat interval the daemon must use once welcomed. */
    readonly heartbeatMs: number;
}

/** Optional behaviour a harness can expose; a case that needs one it lacks is skipped with a reason. */
export type ConformanceFeature = 'env' | 'gap' | 'raw' | 'fs';

export interface DaemonConformanceHarness {
    /** `'env'`: `setEnvironments`; `'gap'`: `truncateLog`; `'raw'`: `PlatformSeat.sendRaw`; `'fs'`: the daemon answers `fs.request` (#187). */
    readonly features?: readonly ConformanceFeature[];
    /** A fresh, paired daemon under test running `script`. Called once per case; the case stops it. */
    start(script: ConformanceScript): Promise<ConformanceDaemon> | ConformanceDaemon;
}

export interface ConformanceDaemon {
    /** The machine the daemon was paired as (USR-04): `hello.machineId` must equal it. */
    readonly machineId: MachineId;
    /** The environment the suite opens sessions on; must appear in `hello.environments`. */
    readonly environmentId: EnvironmentId;
    /** Connect to the platform — again after `PlatformSeat.drop()` to model the daemon's redial. */
    dial(): Promise<PlatformSeat> | PlatformSeat;
    /** Feature `'env'`: change the daemon's environments; it must announce them with `env`. */
    setEnvironments?(environments: readonly EnvironmentDescriptor[]): void | Promise<void>;
    /** Feature `'gap'`: forget the session log before `keepFrom`, so a `wanted` cursor older than that cannot be replayed. */
    truncateLog?(sessionId: SessionId, keepFrom: Cursor): void | Promise<void>;
    stop(): void | Promise<void>;
}

/** The platform end of one connection. */
export interface PlatformSeat {
    send(frame: PlatformFrame): void;
    /** Feature `'raw'`: send text as-is, so the suite can feed malformed input. */
    sendRaw?(text: string): void;
    /** The next message from the daemon: encoded text, or already-parsed JSON. Rejects once dropped. */
    next(): Promise<unknown>;
    /** Break the connection from the platform side; frames in flight are lost. */
    drop(): void;
}
