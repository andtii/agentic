/**
 * The runtimes this package ships, as plugin manifests (PLG-01, PLG-02).
 *
 * A runtime plugin's id IS its `RuntimeId`: the Registry finds an agent's
 * dependency on a runtime by `execution.runtime === manifest.id`. The
 * composition root puts these in its catalogue beside the implementation;
 * nothing here registers anything.
 */

import { DAEMON_HOSTED_CAPABILITY, type PluginManifest, type RuntimeId } from '@agentic/core';
import { DEFAULT_ANTHROPIC_MODEL } from '@sigx/ai-anthropic';
import { ANTHROPIC_PRICING } from './anthropic/pricing.js';

export const ANTHROPIC_API_PLUGIN_ID = 'anthropic-api' satisfies RuntimeId;
export const CLAUDE_CODE_PLUGIN_ID = 'claude-code' satisfies RuntimeId;
export const RUNTIME_PLUGIN_VERSION = '0.1.0';

/** The workspace's Anthropic API key (BYO, EXE-10): a Registry secret, never a config value. */
export const ANTHROPIC_API_KEY_SECRET = 'anthropic-api-key';

/** The models the form offers: the priced ids, and the provider's default even if the table has not caught up with it. */
export const ANTHROPIC_MODEL_IDS: readonly string[] = [...new Set([DEFAULT_ANTHROPIC_MODEL, ...Object.keys(ANTHROPIC_PRICING)])];

export const anthropicApiPlugin: PluginManifest = {
    id: ANTHROPIC_API_PLUGIN_ID,
    version: RUNTIME_PLUGIN_VERSION,
    kind: 'runtime',
    name: 'Anthropic API',
    description: 'Agents run on the platform against the Anthropic API with your own key.',
    capabilities: ['platform-hosted'],
    config: {
        type: 'object',
        properties: {
            defaultModel: {
                type: 'string',
                title: 'Default model',
                description: 'The model an agent runs on when its own config names none.',
                enum: ANTHROPIC_MODEL_IDS,
                default: DEFAULT_ANTHROPIC_MODEL
            }
        },
        additionalProperties: false
    },
    secrets: [
        {
            name: ANTHROPIC_API_KEY_SECRET,
            title: 'Anthropic API key',
            description: 'A key from console.anthropic.com (sk-ant-…). Stored sealed; opened only to start a session.',
            required: true
        }
    ],
    permissions: [{ scope: `secret:${ANTHROPIC_API_KEY_SECRET}`, reason: 'Calls the Anthropic API with your key when a session starts.' }],
    compat: { platform: '*', core: '*' }
};

export const claudeCodePlugin: PluginManifest = {
    id: CLAUDE_CODE_PLUGIN_ID,
    version: RUNTIME_PLUGIN_VERSION,
    kind: 'runtime',
    name: 'Claude Code',
    description: 'Agents run in Claude Code on a paired machine, signed in with the account of the chosen environment. Credentials stay on the machine.',
    capabilities: [DAEMON_HOSTED_CAPABILITY],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }],
    compat: { platform: '*', core: '*' }
};

/** Every runtime manifest this package ships. */
export const RUNTIME_PLUGINS: readonly PluginManifest[] = [anthropicApiPlugin, claudeCodePlugin];
