/**
 * `requireEnabled` — the one call every actor makes before NEW use of a
 * plugin (a session about to open on a runtime, a schedule about to fire
 * through a connector, a tool about to be exposed). Throws
 * `PluginDisabledError` for a missing or disabled plugin; running work is
 * never interrupted by it (AC-13, PLG-03).
 */

import type { WorkspaceId } from '@agentic/core';
import type { ActorClientWith, AnyActorDefinition } from '@sigx/actors';
import { Registry } from './actor.js';
import { registryKey } from './key.js';

/** The slice of an actor context the helper needs — `ctx` of any actor. */
export interface HopContext {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D>;
}

export async function requireEnabled(ctx: HopContext, workspaceId: WorkspaceId, pluginId: string): Promise<void> {
    await ctx.actor(Registry, registryKey(workspaceId)).requireEnabled(pluginId);
}

/** `requireEnabled` as a boolean — for a caller that wants to degrade rather than throw. */
export async function pluginEnabled(ctx: HopContext, workspaceId: WorkspaceId, pluginId: string): Promise<boolean> {
    return ctx.actor(Registry, registryKey(workspaceId)).isEnabled(pluginId);
}
