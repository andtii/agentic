/**
 * Ports the Machine actor is composed with (architecture §4 Machine, §5b).
 *
 * The actor owns the protocol and the record; the host owns the socket.
 * `MachineSocketPort` is how an outbound frame reaches the daemon's
 * hibernatable WebSocket — on Cloudflare the ActorHost Durable Object binds
 * it to `state.getWebSockets(tag)`, tests bind it to a fake — and
 * `ToolCallPort` is where a daemon's `tool.call` runs, under the agent
 * principal the actor mints for it.
 */

import type { Principal, SessionId } from '@agentic/core';
import type { AnyActorDefinition } from '@sigx/actors';

/** The daemon socket(s) for one machine, addressed by actor key. */
export interface MachineSocketPort {
    /** Send one text message to every open daemon socket of `key`. `false` when none is connected. */
    send(key: string, text: string): boolean;
    /** Close the daemon socket(s) of `key`. */
    close(key: string, code: number, reason: string): void;
}

export interface ToolCallInput {
    readonly callId: string;
    readonly sessionId: SessionId;
    readonly tool: string;
    readonly input: unknown;
}

/** Runs a platform tool for a daemon session. A throw becomes `tool.result.error`. */
export interface ToolCallPort {
    call(input: ToolCallInput, principal: Principal): Promise<unknown>;
}

/** What a `ToolCallPort` throws to name the error code the daemon sees (default `internal`). */
export class ToolCallError extends Error {
    override readonly name = 'ToolCallError';
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

export interface MachinePorts {
    readonly socket: MachineSocketPort;
    /**
     * The Session actor definition this app built (`defineSessionActor`),
     * as a thunk because Session and Machine reference each other. Without
     * it session traffic is recorded on the machine but reaches no Session.
     */
    readonly sessions?: () => AnyActorDefinition;
    /** Absent → every `tool.call` is answered with an `unsupported` error. */
    readonly tools?: ToolCallPort;
    /**
     * The Routing actor definition (`defineRoutingActor`), as a thunk like
     * `sessions`. When set, the machine tells the router — one-way, as itself —
     * that it came online (`hello`), that a hosted session was acknowledged by
     * the daemon (`session.opened`) and that one is gone (`session.closed`), so
     * tasks waiting on this machine resume or fail with a reason (§7, EXE-11).
     */
    readonly routing?: () => AnyActorDefinition;
    /** Clock for tests. Default `Date.now`. */
    readonly now?: () => number;
    /**
     * A machine with no heartbeat for this long is offline. Default 90 s —
     * three daemon heartbeats; the check runs on the 60 s reminder floor.
     */
    readonly heartbeatWindowMs?: number;
    /** How long a `sendCommand` waits for its reply before answering the Session with an error. Default 120 s. */
    readonly commandTimeoutMs?: number;
    /**
     * How long an `fsRequest` waits for the daemon's `fs.response` before it
     * fails with `timeout`. Default 30 s; the liveness reminder checks on its
     * 60 s floor, so a silent daemon's request fails within one tick after.
     */
    readonly fsTimeoutMs?: number;
}
