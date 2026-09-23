/**
 * The runtimes this package ships, as plugin manifests (PLG-01, PLG-02).
 *
 * A runtime plugin's id IS its `RuntimeId`: the Registry finds an agent's
 * dependency on a runtime by `execution.runtime === manifest.id`. The
 * composition root puts these in its catalogue beside the implementation;
 * nothing here registers anything.
 */

import { DAEMON_HOSTED_CAPABILITY, HARNESS_RUNTIME_CAPABILITY, MODEL_RUNTIME_CAPABILITY, PLATFORM_HOSTED_CAPABILITY, USAGE_LIMITS_CAPABILITY, type PluginManifest, type RuntimeId } from '@agentic/core';
import { DEFAULT_ANTHROPIC_MODEL } from '@sigx/ai-anthropic';
import { ANTHROPIC_PRICING } from './anthropic/pricing.js';

export const ANTHROPIC_API_PLUGIN_ID = 'anthropic-api' satisfies RuntimeId;
export const CLAUDE_CODE_PLUGIN_ID = 'claude-code' satisfies RuntimeId;
export const CODEX_CLI_PLUGIN_ID = 'codex-cli' satisfies RuntimeId;
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
    // A model runtime: the platform runs the loop over the API (#313).
    capabilities: [PLATFORM_HOSTED_CAPABILITY, MODEL_RUNTIME_CAPABILITY],
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
            description: 'A key from console.anthropic.com (sk-ant-…). Stored sealed; opened only to start a session or to title a chat.',
            required: true
        }
    ],
    permissions: [{ scope: `secret:${ANTHROPIC_API_KEY_SECRET}`, reason: 'Calls the Anthropic API with your key when a session starts, and once or twice per chat to title it.' }],
    compat: { platform: '*', core: '*' }
};

/**
 * The models a Claude Code member can switch to before its account reports its own (#453): the adapter's
 * `CLAUDE_CODE_MODELS` plus the ones it leaves out that a subscription may have. Spelled out, not imported: this entry
 * runs in the Worker and the adapter is Node's (a test keeps the two in step). An environment's `models` replace it.
 */
export const CLAUDE_CODE_MODEL_IDS: readonly string[] = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

/** Claude Code's permission modes (#453), the adapter's `PERMISSION_MODES`; `bypassPermissions` only runs where the environment allows it. */
export const CLAUDE_CODE_PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];

export const claudeCodePlugin: PluginManifest = {
    id: CLAUDE_CODE_PLUGIN_ID,
    version: RUNTIME_PLUGIN_VERSION,
    kind: 'runtime',
    name: 'Claude Code',
    description: 'Agents run in Claude Code on a paired machine, signed in with the account of the chosen environment, and each account reports its plan usage limits. Credentials stay on the machine.',
    // A harness runtime (its own loop, driven through the Agent SDK) that reports its accounts' usage limits (#261, #313).
    capabilities: [DAEMON_HOSTED_CAPABILITY, HARNESS_RUNTIME_CAPABILITY, USAGE_LIMITS_CAPABILITY],
    // No `default`s: without a configured value Claude Code picks its own model and asks in its `default` mode.
    config: {
        type: 'object',
        properties: {
            defaultModel: {
                type: 'string',
                title: 'Default model',
                description: 'The model an agent runs on when its own config names none. An account that reports its own models lists those in a chat.',
                enum: CLAUDE_CODE_MODEL_IDS
            },
            defaultPermissionMode: {
                type: 'string',
                title: 'Default permission mode',
                description: 'How Claude Code asks before it runs a tool, when a chat sets no mode for the member. bypassPermissions runs only in environments that allow it.',
                enum: CLAUDE_CODE_PERMISSION_MODES
            }
        },
        additionalProperties: false
    },
    permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }],
    compat: { platform: '*', core: '*' }
};

/** The id of the Claude Code `QuotaSource` (#269): the `sourceId` its snapshots carry. A capability of `claudeCodePlugin`, not a plugin (#313). */
export const CLAUDE_CODE_QUOTA_ID = 'agentic.quota.claude-code';
export const QUOTA_SOURCE_VERSION = '0.1.0';

export const COPILOT_CLI_PLUGIN_ID = 'copilot-cli' satisfies RuntimeId;
/** The id of the Copilot CLI `QuotaSource`: the `sourceId` its snapshots carry. */
export const COPILOT_CLI_QUOTA_ID = 'agentic.quota.copilot-cli';

/** GitHub Copilot CLI on a paired machine (#319): harness runtime, one GitHub account per environment. */
export const copilotCliPlugin: PluginManifest = {
    id: COPILOT_CLI_PLUGIN_ID,
    version: RUNTIME_PLUGIN_VERSION,
    kind: 'runtime',
    name: 'Copilot CLI',
    description: 'Agents run in GitHub Copilot CLI on a paired machine, signed in with the GitHub account of the chosen environment, and each account reports its monthly premium requests. Credentials stay on the machine.',
    // A harness runtime (its own loop, driven through the Copilot SDK) that reports its accounts' request allowance.
    capabilities: [DAEMON_HOSTED_CAPABILITY, HARNESS_RUNTIME_CAPABILITY, USAGE_LIMITS_CAPABILITY],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }],
    compat: { platform: '*', core: '*' }
};

export const codexCliPlugin: PluginManifest = {
    id: CODEX_CLI_PLUGIN_ID,
    version: RUNTIME_PLUGIN_VERSION,
    kind: 'runtime',
    name: 'Codex',
    description: 'Agents run in OpenAI Codex on a paired machine, signed in with the account of the chosen environment, and each ChatGPT account reports its plan usage limits. Credentials stay on the machine.',
    // A harness runtime driven through `codex app-server` that reports its accounts' usage limits (#320).
    capabilities: [DAEMON_HOSTED_CAPABILITY, HARNESS_RUNTIME_CAPABILITY, USAGE_LIMITS_CAPABILITY],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: [{ scope: 'machine:*', reason: 'Starts sessions on your paired machines, inside the folders their environments allow.' }],
    compat: { platform: '*', core: '*' }
};

/** The id of the Codex `QuotaSource` (#320): the `sourceId` its snapshots carry. */
export const CODEX_CLI_QUOTA_ID = 'agentic.quota.codex-cli';

/** Every runtime manifest this package ships. */
export const RUNTIME_PLUGINS: readonly PluginManifest[] = [anthropicApiPlugin, claudeCodePlugin, copilotCliPlugin, codexCliPlugin];
