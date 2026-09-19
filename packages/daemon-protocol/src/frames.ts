/**
 * The envelope, instantiated: `@agentic/core` keeps `DaemonFrame<F, R>` and
 * `PlatformFrame<C>` generic so it stays dependency-free; here `F`, `R` and
 * `C` are the `@sigx/ai-agent/wire` frame, reply and command, which is what
 * actually crosses the daemon socket (architecture §5b).
 */

import type { DaemonFrame as CoreDaemonFrame, PlatformFrame as CorePlatformFrame } from '@agentic/core';
import type { WireCommand, WireFrame, WireReply } from '@sigx/ai-agent/wire';

export type DaemonFrame = CoreDaemonFrame<WireFrame, WireReply>;
export type PlatformFrame = CorePlatformFrame<WireCommand>;

export type DaemonFrameType = DaemonFrame['t'];
export type PlatformFrameType = PlatformFrame['t'];

/** One daemon frame kind by its `t`. */
export type DaemonFrameOf<T extends DaemonFrameType> = Extract<DaemonFrame, { readonly t: T }>;
/** One platform frame kind by its `t`. */
export type PlatformFrameOf<T extends PlatformFrameType> = Extract<PlatformFrame, { readonly t: T }>;

export type HelloFrame = DaemonFrameOf<'hello'>;
export type EnvFrame = DaemonFrameOf<'env'>;
export type HeartbeatFrame = DaemonFrameOf<'heartbeat'>;
export type SessionOpenedFrame = DaemonFrameOf<'session.opened'>;
export type SessionFrameFrame = DaemonFrameOf<'session.frame'>;
export type SessionReplyFrame = DaemonFrameOf<'session.reply'>;
export type SessionClosedFrame = DaemonFrameOf<'session.closed'>;
export type ToolCallFrame = DaemonFrameOf<'tool.call'>;
export type PongFrame = DaemonFrameOf<'pong'>;
export type FsResponseFrame = DaemonFrameOf<'fs.response'>;
export type EnvResponseFrame = DaemonFrameOf<'env.response'>;

export type WelcomeFrame = PlatformFrameOf<'welcome'>;
export type SessionOpenFrame = PlatformFrameOf<'session.open'>;
export type SessionCommandFrame = PlatformFrameOf<'session.command'>;
export type SessionCloseFrame = PlatformFrameOf<'session.close'>;
export type ToolResultFrame = PlatformFrameOf<'tool.result'>;
export type PingFrame = PlatformFrameOf<'ping'>;
export type FsRequestFrame = PlatformFrameOf<'fs.request'>;
export type EnvRequestFrame = PlatformFrameOf<'env.request'>;

/** Either direction. */
export type AnyFrame = DaemonFrame | PlatformFrame;
