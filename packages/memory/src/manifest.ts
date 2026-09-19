/**
 * The memory plugins this package ships, as plugin manifests (PLG-02, MEM-02).
 *
 * `memory` is a single-slot kind: a workspace runs one of these at a time.
 * The default's id is the one `memoryPlugin()` reports — the platform's
 * Memory-actor-backed plugin is that same plugin over a durable backend.
 */

import type { PluginManifest } from '@agentic/core';
import { FLAT_MEMORY_PLUGIN_ID, FLAT_MEMORY_PLUGIN_VERSION } from './plugins/flat/index.js';
import { DEFAULT_MEMORY_PLUGIN_ID, DEFAULT_MEMORY_PLUGIN_VERSION } from './store/index.js';

const MEMORY_PERMISSIONS: PluginManifest['permissions'] = [
    { scope: 'memory:read', reason: 'Retrieves memories for a session.' },
    { scope: 'memory:write', reason: 'Stores, updates and retires memories.' }
];

export const memoryDefaultPlugin: PluginManifest = {
    id: DEFAULT_MEMORY_PLUGIN_ID,
    version: DEFAULT_MEMORY_PLUGIN_VERSION,
    kind: 'memory',
    name: 'Memory',
    description: 'The default memory: ranked keyword retrieval, conditions, evidence and superseding, with a full export.',
    capabilities: ['retrieval:ranked', 'export:full'],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: MEMORY_PERMISSIONS,
    compat: { platform: '*', core: '*' }
};

export const memoryFlatPlugin: PluginManifest = {
    id: FLAT_MEMORY_PLUGIN_ID,
    version: FLAT_MEMORY_PLUGIN_VERSION,
    kind: 'memory',
    name: 'Flat memory',
    description: 'A plain list with substring retrieval. It keeps no conditions, evidence, superseding or expiry — a migration into it reports what is lost.',
    capabilities: ['retrieval:substring', 'export:partial'],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: MEMORY_PERMISSIONS,
    compat: { platform: '*', core: '*' }
};

/** Every memory manifest this package ships; the first is the workspace default. */
export const MEMORY_PLUGINS: readonly PluginManifest[] = [memoryDefaultPlugin, memoryFlatPlugin];
