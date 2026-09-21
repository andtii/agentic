/**
 * Session options a chat member overrides for its sessions (#450): the model and
 * the runtime's permission mode. The agent's config stays the default; an override
 * applies to the member's next turn in that chat, never the running one (AGT-07).
 */

/** What a chat member overrides; absent keys fall back to the agent's config, then the runtime plugin's default. */
export interface SessionOptions {
    readonly model?: string;
    /** A mode the runtime lists (Claude Code: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, `bypassPermissions`). */
    readonly permissionMode?: string;
}

/** A change to a member's options: a value sets it, `null` clears it back to the default, an absent key leaves it. */
export type SessionOptionsPatch = { readonly [K in keyof SessionOptions]?: SessionOptions[K] | null };

/** One model a runtime or account offers, as it names it. */
export interface ModelOption {
    readonly id: string;
    readonly label?: string;
    readonly description?: string;
}

/** Claude Code's permission mode that runs every tool unasked: offered only where the environment allows it (`allowBypassPermissions`). */
export const BYPASS_PERMISSIONS_MODE = 'bypassPermissions';

/** `options` with `patch` applied: `null` removes a key; `undefined` when nothing is left. */
export function applySessionOptions(options: SessionOptions | undefined, patch: SessionOptionsPatch): SessionOptions | undefined {
    const next: Record<string, string> = { ...(options as Record<string, string> | undefined) };
    for (const [key, value] of Object.entries(patch) as [keyof SessionOptions, string | null | undefined][]) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
    }
    return Object.keys(next).length ? (next as SessionOptions) : undefined;
}
