/**
 * What `daemonConformance` needs from the thing under test. The suite sits
 * in the PLATFORM seat of the socket and drives a daemon whose runtime is
 * scripted: the harness builds that daemon (a real `agentic-daemon` over a
 * `mockAgent`, or the in-memory fake in `./in-memory`) and hands the suite
 * one end of each connection. Transport is the harness's business — an
 * in-memory queue, a WebSocket pair, a relay.
 */

import type { Cursor, EnvironmentDescriptor, EnvironmentId, LoginAction, MachineId, MachinePolicy, ReleaseAsset, RuntimeId, SessionId } from '@agentic/core';
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
    /** The runtime's title for every conversation (#460): sent as `session.title` after a session's first turn. Absent: the runtime titles nothing. */
    readonly title?: string;
}

/** Optional behaviour a harness can expose; a case that needs one it lacks is skipped with a reason. */
export type ConformanceFeature = 'env' | 'gap' | 'raw' | 'fs' | 'files' | 'env-manage' | 'session-ref' | 'history' | 'build' | 'resume' | 'update' | 'harness' | 'policy' | 'log' | 'login' | 'restart';

export interface DaemonConformanceHarness {
    /**
     * `'env'`: `setEnvironments`; `'gap'`: `truncateLog`; `'raw'`: `PlatformSeat.sendRaw`; `'fs'`: the daemon answers `fs.request` (#187);
     * `'env-manage'`: the daemon answers `env.request` (#236), starts with a policy that has `webManaged` on and at least one allowed root
     * that exists, and implements `setPolicy`; `'session-ref'`: the daemon reports the runtime's own id for a session with
     * `session.ref` once the runtime names it (#388), an id other than the placeholder `session.opened` carried; `'history'`: the daemon
     * answers `history.request` from its own log (#397) — and, with `truncateLog`, a range the log no longer reaches with a named `gap`;
     * `'build'`: `hello` carries `build` and `features` (#359); `'resume'`: the daemon implements `restart`, answers a `wanted` session it
     * lost with `session.closed { code: 'restart' }` and re-opens it from `spec.resume` on a later epoch (#363); `'update'`: the daemon
     * answers `update.request` / `update.cancel` (#364) and the harness names an `updateTarget`; `'harness'`: the daemon answers
     * `harness.request` (#369) and the harness names a `harnessTarget`; `'policy'`: the daemon answers `policy.request` (#355) —
     * `set` with `~` expanded to its user's home and its own folder refused, `browse` — and implements `lock`; `'log'`: the daemon
     * answers `log.request` from a log that holds at least `logLines` lines; `'login'`: the daemon relays a sign-in for the suite
     * environment (`login.request`, the `loginAction` it will show, and `loginAnswer` when the action expects a paste); `'restart'`:
     * the daemon restarts on `update.request { target: 'restart' }` — no download, `session.closed { code: 'restart' }`; `'files'`: the daemon
     * lists `files` in `hello.features` and answers `fs.request` `tree` / `read` / `changes` (#559) over the harness's `files` folders.
     */
    readonly features?: readonly ConformanceFeature[];
    /**
     * Feature `'fs'`, optional: a remote URL of which at least one checkout lies under the suite environment's `cwdRoots`,
     * so `fs-locate` can prove a match (#331). Without it the case only checks the shape of an empty answer.
     */
    readonly knownOrigin?: string;
    /** Feature `'files'`: the folders the session-files cases read (#559). */
    readonly files?: ConformanceFiles;
    /** Feature `'update'`: a release the daemon can update to — what it downloads is the harness's business. */
    readonly updateTarget?: ReleaseAsset;
    /** Feature `'harness'`: a harness build the daemon can install, for a runtime it has a driver for. */
    readonly harnessTarget?: { readonly runtime: RuntimeId; readonly asset: ReleaseAsset };
    /** Feature `'policy'`: a folder of the daemon's own (its configuration, say) that a policy must refuse `protected` and a browse must never list. */
    readonly protectedFolder?: string;
    /** Feature `'log'`: how many lines the daemon's log holds at least, so the suite can ask for fewer and see `truncated`. */
    readonly logLines?: number;
    /** Feature `'login'`: the action the daemon will show for the suite environment's sign-in, and the text that completes it when it expects a paste. */
    readonly loginAction?: LoginAction;
    readonly loginAnswer?: string;
    /** A fresh, paired daemon under test running `script`. Called once per case; the case stops it. */
    start(script: ConformanceScript): Promise<ConformanceDaemon> | ConformanceDaemon;
}

/**
 * Folders under the suite environment's `cwdRoots` for the `files` cases (#559). `root` holds `file` (relative, `/`-separated,
 * at least one folder deep) with exactly `file.text` on disk. With `changed`, `root` is under version control and `file`
 * differs from its last commit; `plain`, when given, is a folder inside the roots that is under no version control.
 */
export interface ConformanceFiles {
    readonly root: string;
    readonly file: { readonly path: string; readonly text: string };
    readonly changed?: boolean;
    readonly plain?: string;
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
    /** Feature `'env-manage'`: change the machine-local policy the way its owner would, on the machine; the daemon must announce it with `env`. */
    setPolicy?(policy: MachinePolicy): void | Promise<void>;
    /** Feature `'policy'`: `agentic-daemon policy lock` / `unlock` on the machine (#355); the daemon must announce it with `env`. */
    lock?(locked: boolean): void | Promise<void>;
    /** Feature `'gap'`: forget the session log before `keepFrom`, so a `wanted` cursor older than that cannot be replayed. */
    truncateLog?(sessionId: SessionId, keepFrom: Cursor): void | Promise<void>;
    /**
     * Feature `'resume'`: restart the daemon process the way a crash and its supervisor would — the connection and every live
     * session are lost, the session logs on disk are kept. The suite dials again afterwards.
     */
    restart?(): void | Promise<void>;
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
