/**
 * @agentic/plugins-plan — the plan project feature (#753; PRJ-06, PRJ-11; `docs/architecture.md` §10 "Projects
 * (redesign)"). An ordinary project feature: its manifest declares the Plan section (open items counted), the overview
 * card, the Ready/Do/Review/Done work stages, the `#` item ref and the `plan` tool family; `instructions()` tells every
 * session of the project how to use the plan tools and the ref syntax. The plan store and the tool handlers live with
 * the Plan actor and the `plan` tool family, not here.
 *
 * Edge-safe: `@agentic/core` only, no `node:` imports; it runs on the router and in the browser.
 */

import { PLAN_LEASE_DEFAULT_MS, PLAN_TOOLS, PROJECT_FEATURE_KIND, type ConfigSchema, type PlanToolName, type ProjectFeatureContext, type ProjectFeatureManifest, type ProjectFeaturePlugin, type ProjectFeaturePreset, type ProjectFeaturePreviewInput, type ProjectFeaturePreviewLine } from '@agentic/core';
import { PLAN_TEMPLATES, planTemplateItemCount, EVENT_DAY_TEMPLATE, RELEASE_TEMPLATE } from './templates.js';

export { EVENT_DAY_TEMPLATE, PLAN_TEMPLATES, planTemplateItemCount, RELEASE_TEMPLATE, type PlanTemplate, type PlanTemplatePhase } from './templates.js';

/** The plugin's id: what a project stores its settings under (`features['agentic.feature.plan']`). */
export const PLAN_FEATURE_ID = 'agentic.feature.plan';
export const PLAN_FEATURE_VERSION = '0.1.0';

/** The stages a work item moves through when Plan supplies them. */
export const PLAN_WORK_STAGES = ['Ready', 'Do', 'Review', 'Done'] as const;

/** Default lease in minutes, from core's default. */
export const DEFAULT_LEASE_MINUTES = PLAN_LEASE_DEFAULT_MS / 60_000;

/** What each plan tool does, as the agent is told it (HANDOFF "Agent tools and refs"). */
export const PLAN_TOOL_SUMMARIES: Readonly<Record<PlanToolName, string>> = {
    plan_list: 'items with state, owner, deps and refs',
    plan_next: 'the next item from your own queue, then open items; its deps done, no path clash',
    plan_claim: 'start an item with a lease; refused if it is blocked, taken, or you are over your limit',
    plan_assign: "put an item in an agent's queue (project manager and people)",
    plan_update: 'tick done-when, add a note, change state',
    plan_ref: 'attach a ref to an item',
    plan_add: 'add items or split one (project manager and people)',
    plan_handoff: 'release an item with a note to an agent or a person'
};

export const planProjectSettings: ConfigSchema = {
    type: 'object',
    properties: {
        agentsMayTick: {
            type: 'boolean',
            title: 'Agents may tick items',
            description: "Agents may tick an item's done-when lines and mark it done. Off: an agent asks, and a person ticks.",
            default: true
        },
        claimLimit: {
            type: 'integer',
            title: 'Items per agent at once',
            description: 'How many items one agent may have claimed at the same time.',
            minimum: 1,
            maximum: 10,
            default: 1
        },
        leaseMinutes: {
            type: 'integer',
            title: 'Claim lease (minutes)',
            description: "How long a claim lasts without a plan_* call; when it runs out the item goes back to the top of its assignee's queue and the project manager is told.",
            minimum: 5,
            maximum: 480,
            default: DEFAULT_LEASE_MINUTES
        },
        starter: {
            type: 'string',
            title: 'Starter plan',
            description: 'The phases and items a new plan in this project starts with.',
            enum: ['none', ...Object.keys(PLAN_TEMPLATES)],
            default: 'none'
        },
        instructions: {
            type: 'string',
            title: 'Instructions',
            description: 'How this project uses its plan: joined into the system prompt of every session in the project, after the plan tools.',
            default: ''
        }
    },
    additionalProperties: false
};

export const planFeatureManifest: ProjectFeatureManifest = {
    id: PLAN_FEATURE_ID,
    version: PLAN_FEATURE_VERSION,
    kind: PROJECT_FEATURE_KIND,
    name: 'Plan',
    description: 'A shared plan people and agents work from together: phases of items, queues and claims, # refs and plan tools for agents.',
    capabilities: ['instructions', 'tools'],
    config: { type: 'object', properties: {}, additionalProperties: false },
    permissions: [],
    compat: { platform: '*', core: '*' },
    projectSettings: planProjectSettings,
    category: 'planning',
    ui: {
        section: { label: 'Plan', icon: 'check', badge: 'open-items' },
        overviewCard: { title: 'Plan' },
        workStages: PLAN_WORK_STAGES,
        chatRefPrefixes: ['#'],
        tools: ['plan']
    }
};

/** Named starting points for the settings (#621 shape): each only fills fields, never `instructions`, and `null` clears one back to its default. */
export const PLAN_PRESETS: readonly ProjectFeaturePreset[] = [
    {
        id: 'blank',
        label: 'Blank plan',
        description: 'start empty; one item per agent at a time',
        settings: { starter: null, claimLimit: null, agentsMayTick: null }
    },
    {
        id: 'event-day',
        label: `Event day (${planTemplateItemCount(EVENT_DAY_TEMPLATE)} items)`,
        description: 'decide, book, invite, run and wrap up a day; people tick items, agents chase and draft',
        settings: { starter: EVENT_DAY_TEMPLATE.id, claimLimit: 3, agentsMayTick: false }
    },
    {
        id: 'release',
        label: `Release (${planTemplateItemCount(RELEASE_TEMPLATE)} items)`,
        description: 'scope, build, check and ship a release; agents tick what they finish',
        settings: { starter: RELEASE_TEMPLATE.id, claimLimit: null, agentsMayTick: true }
    }
];

const intSetting = (settings: Readonly<Record<string, unknown>>, key: string, fallback: number): number => {
    const value = settings[key];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * The plan fragment of every session's `## Project` section: the plan tools, the ref syntax and the rules the platform
 * enforces, with this project's limits, then the project's own instructions.
 */
export function planInstructions({ settings }: ProjectFeatureContext): string {
    const limit = intSetting(settings, 'claimLimit', 1);
    const lease = intSetting(settings, 'leaseMinutes', DEFAULT_LEASE_MINUTES);
    const mayTick = settings['agentsMayTick'] !== false;
    const lines = [
        'This project has a plan: phases of items, each carried out by a task (plan → item → task). Work from it with the plan tools:',
        ...PLAN_TOOLS.map((t) => `- \`${t}\`: ${PLAN_TOOL_SUMMARIES[t]}`),
        '',
        `Rules: claim an item before working on it — at most ${limit} at once. A claim lasts ${lease} minutes and renews on every plan_* call; when it runs out the item returns to your queue and the project manager is told. An item whose \`after\` items are not done cannot be claimed. If your item's touches overlap another claimed item's, say so and agree an order. Hand an item off with plan_handoff rather than dropping it.`,
        mayTick
            ? "Tick each done-when line with plan_update as you meet it; an item is done when all are ticked."
            : 'Do not tick done-when lines yourself: when you think one is met, say so with plan_update (a note) and a person ticks it.',
        '',
        'Refs work the same in chats, items and notes: `#9` an item, `signalx#14` an item in another project, `@lint` an agent or person, `path/file.ts:38-41` file lines, `pr:604` a pull request, `4f2a9c1` a commit, `chat:msg-42` a chat message, `doc:architecture.md#7` a doc section, or any URL. Attach them to items with plan_ref.'
    ];
    const own = typeof settings['instructions'] === 'string' ? settings['instructions'].trim() : '';
    if (own) lines.push('', own);
    return lines.join('\n');
}

/** Problems the schema cannot say: an unknown starter plan. */
export function planSettingsErrors(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
    const starter = settings['starter'];
    if (starter !== undefined && starter !== 'none' && (typeof starter !== 'string' || !Object.hasOwn(PLAN_TEMPLATES, starter))) return { starter: `no starter plan called "${String(starter)}"` };
    return {};
}

/** What the settings do: the starter plan, the claim rules and who ticks. */
export function previewPlanSettings({ settings }: ProjectFeaturePreviewInput): readonly ProjectFeaturePreviewLine[] {
    const starter = typeof settings['starter'] === 'string' && Object.hasOwn(PLAN_TEMPLATES, settings['starter']) ? PLAN_TEMPLATES[settings['starter']] : undefined;
    return [
        { label: 'New plan', value: starter ? `${starter.title}: ${starter.phases.length} phases, ${planTemplateItemCount(starter)} items` : 'empty' },
        { label: 'Claims', value: `${intSetting(settings, 'claimLimit', 1)} per agent, ${intSetting(settings, 'leaseMinutes', DEFAULT_LEASE_MINUTES)} min lease` },
        { label: 'Done-when', value: settings['agentsMayTick'] === false ? 'people tick' : 'agents and people tick' }
    ];
}

/** The plan feature: instructions for every session, the settings presets and preview. */
export const planFeaturePlugin: ProjectFeaturePlugin = {
    manifest: planFeatureManifest,
    instructions: planInstructions,
    presets: PLAN_PRESETS,
    settingsErrors: planSettingsErrors,
    previewSettings: previewPlanSettings
};
