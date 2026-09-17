/**
 * The Agent actor's state and its version log (AGT-06, LRN-08).
 *
 * Every durable config change is ONE entry `{ t: 'config', v, patch, by, at,
 * reason }` folded into the state by `applyAgentEntry` — a pure reducer in
 * the shape `@sigx/actors` expects for `applyEntry` (#312). The installed
 * 0.9.2 does not ship `ctx.append` yet, so the actor calls the reducer
 * itself and `ctx.save()`s; when the append log lands, the definition gains
 * `applyEntry: applyAgentEntry` and the method body becomes `ctx.append(entry)`
 * with nothing else changing.
 *
 * The log stays IN the state (not only in storage) because `rollback` and
 * `listVersions` replay it, and a replay must give the same answer on every
 * host — hence `mergeAgentConfig` is deterministic and entries are never
 * edited after the fact.
 */

import type { AgentConfig, AgentConfigVersion, AgentId, WorkspaceId } from '@agentic/core';
import { type AgentConfigPatch, defaultAgentConfig, mergeAgentConfig } from './config.js';

/** One durable config version, exactly as appended. */
export interface AgentConfigEntry {
    readonly t: 'config';
    /** 1-based, dense: entry `v` is `versions[v - 1]`. */
    readonly v: number;
    readonly patch: AgentConfigPatch;
    /** Who made the change — `user:<id>`, `agent:<id>`, `external:<clientId>`, or `system`. */
    readonly by: string;
    readonly at: number;
    readonly reason: string;
    /** Set when this version was produced by `rollback`: the version it reproduces. */
    readonly rollbackOf?: number;
}

/** What `listVersions` returns: the core version record plus the rollback link. */
export interface AgentVersionInfo extends AgentConfigVersion {
    readonly rollbackOf?: number;
}

export interface AgentState {
    id: AgentId;
    workspaceId: WorkspaceId;
    /** Folded: `defaultAgentConfig()` with every entry's patch applied in order. */
    config: AgentConfig;
    /** `versions.length`; `0` until the first `update` — an agent that was never configured. */
    configVersion: number;
    versions: AgentConfigEntry[];
}

/** `{ws}:agent:{id}` → its parts; throws on any other shape so activation fails loudly. */
export function parseAgentKey(key: string): { workspaceId: WorkspaceId; id: AgentId } {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[1] !== 'agent' || !parts[0] || !parts[2]) {
        throw new TypeError(`not an agent key: "${key}" (expected "{ws}:agent:{id}")`);
    }
    return { workspaceId: parts[0] as WorkspaceId, id: parts[2] as AgentId };
}

export function initialAgentState(key: string): AgentState {
    const { workspaceId, id } = parseAgentKey(key);
    return { id, workspaceId, config: defaultAgentConfig(), configVersion: 0, versions: [] };
}

/**
 * Fold one entry into the state, in place. Pure in (state, entry): the
 * version number is taken from the entry, not computed, so a replay and the
 * live append agree by construction. Throws on a gap — a log with a missing
 * version cannot be replayed faithfully.
 */
export function applyAgentEntry(state: AgentState, entry: unknown): void {
    const e = entry as AgentConfigEntry;
    if (e.t !== 'config') throw new TypeError(`unknown agent entry "${String(e.t)}"`);
    if (e.v !== state.configVersion + 1) {
        throw new RangeError(`agent entry v${e.v} does not follow v${state.configVersion}`);
    }
    state.config = mergeAgentConfig(state.config, e.patch);
    state.configVersion = e.v;
    state.versions.push(e);
}

/** The config as it stood at `version` — replayed from the defaults. */
export function configAtVersion(versions: readonly AgentConfigEntry[], version: number): AgentConfig {
    if (!Number.isInteger(version) || version < 1 || version > versions.length) {
        throw new RangeError(`no agent config version ${version} (have 1..${versions.length})`);
    }
    let config = defaultAgentConfig();
    for (let i = 0; i < version; i++) config = mergeAgentConfig(config, versions[i]!.patch);
    return config;
}

export function versionInfo(entry: AgentConfigEntry): AgentVersionInfo {
    const info: AgentVersionInfo = { version: entry.v, at: entry.at, by: entry.by, reason: entry.reason };
    return entry.rollbackOf === undefined ? info : { ...info, rollbackOf: entry.rollbackOf };
}
