/** The default learning plugin, as a plugin manifest (PLG-02, LRN-01). `learning` is a single-slot kind. */

import type { PluginManifest } from '@agentic/core';
import { DEFAULT_LEARNING_PLUGIN_ID, DEFAULT_LEARNING_PLUGIN_VERSION } from './plugin/index.js';

export const learningDefaultPlugin: PluginManifest = {
    id: DEFAULT_LEARNING_PLUGIN_ID,
    version: DEFAULT_LEARNING_PLUGIN_VERSION,
    kind: 'learning',
    name: 'Learning',
    description: 'Turns corrections into lessons and task outcomes into records. Memory writes are automatic; instruction changes are proposals you review.',
    capabilities: ['corrections', 'task-outcomes', 'instruction-proposals'],
    config: {
        type: 'object',
        properties: {
            repeatThreshold: {
                type: 'integer',
                title: 'Repeats before an instruction change',
                description: "How many times the same correction is made before a change to the agent's instructions is proposed for your review.",
                minimum: 1,
                maximum: 20,
                default: 3
            }
        },
        additionalProperties: false
    },
    permissions: [
        { scope: 'memory:read', reason: 'Finds earlier lessons before it writes a new one.' },
        { scope: 'memory:write', reason: 'Writes lessons and task records to memory.' }
    ],
    compat: { platform: '*', core: '*' }
};
