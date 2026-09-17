/** Plugin declarations (PLG-01..05). */

export type PluginKind = 'runtime' | 'connector' | 'memory' | 'learning' | 'notification' | 'trigger' | 'a2a';

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

export type JsonSchema = { readonly [key: string]: unknown };

export interface PluginManifest {
    readonly id: string;
    readonly version: string;
    readonly kind: PluginKind;
    readonly name: string;
    readonly description: string;
    readonly capabilities: readonly string[];
    readonly config: JsonSchema;
    readonly permissions: readonly { readonly scope: PermissionScope; readonly reason: string }[];
    readonly compat: { readonly platform: string; readonly core: string };
}

export interface PluginState {
    readonly manifest: PluginManifest;
    readonly enabled: boolean;
    readonly config: Record<string, unknown>;
    readonly grantedPermissions: readonly PermissionScope[];
}
