/** Plugin declarations (PLG-01..05). The config schema, its validation and readiness live in `plugin-config.ts`. */

import type { ToolMode } from './agent.js';
import type { ConfigSchema, PluginSecretDeclaration } from './plugin-config.js';

export type PluginKind = 'runtime' | 'connector' | 'memory' | 'learning' | 'notification' | 'trigger' | 'a2a' | 'project-feature';

/** What a plugin may be granted; nothing is implicit (PLG-04). */
export type PermissionScope =
    | 'secret:*'
    | `secret:${string}`
    | 'machine:*'
    | `machine:${string}`
    | `network:${string}`
    | 'memory:read'
    | 'memory:write'
    | 'tools:*'
    | `tools:${string}`;

/** @deprecated The old name of a manifest's config schema — use `ConfigSchema`. */
export type JsonSchema = ConfigSchema;

/** Kinds a workspace runs exactly ONE plugin of at a time (the active one); every other kind runs all that are enabled. */
export const SINGLE_SLOT_KINDS: readonly PluginKind[] = ['memory', 'learning'];

export function isSingleSlot(kind: PluginKind): boolean {
    return SINGLE_SLOT_KINDS.includes(kind);
}

/** A tool a plugin brings, by the namespaced name sessions see (`gmail__send-email`). */
export interface PluginToolDeclaration {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    /** The mode the tool starts in until the workspace picks one; `defaultToolMode` derives one from tool hints. */
    readonly defaultMode?: ToolMode;
}

export interface PluginManifest {
    readonly id: string;
    readonly version: string;
    readonly kind: PluginKind;
    readonly name: string;
    readonly description: string;
    readonly capabilities: readonly string[];
    readonly config: ConfigSchema;
    /** Secrets the plugin needs. Never config properties; each takes a declared `secret:<name>` permission to open (PLG-04). */
    readonly secrets?: readonly PluginSecretDeclaration[];
    readonly permissions: readonly { readonly scope: PermissionScope; readonly reason: string }[];
    readonly compat: { readonly platform: string; readonly core: string };
    /** The tools the plugin brings, each with the mode it starts in (PLG-09). */
    readonly tools?: readonly PluginToolDeclaration[];
}

export interface PluginState {
    readonly manifest: PluginManifest;
    readonly enabled: boolean;
    readonly config: Record<string, unknown>;
    readonly grantedPermissions: readonly PermissionScope[];
}
