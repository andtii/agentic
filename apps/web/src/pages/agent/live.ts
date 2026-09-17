/**
 * The live agent pages' view model (#35): pure adapters from what the Agent
 * actor returns — `Agent.get()`, `Agent.listVersions()` — to the
 * `AgentProfile` the roster, header and tabs already render from the mock
 * workspace, plus the patch a form submit persists. Nothing here touches
 * a hook or the DOM.
 */
import type { AgentConfig, AgentConfigVersion } from '@agentic/core';
import type { AgentConfigPatch, AgentView } from '@agentic/platform';
import type { AgentProfile } from '../../mock/agents';
import { identityOf } from '../chat/live';

/** The version reason the roster's dialog records when nobody typed one. */
export const CREATED_REASON = 'Created in the web UI';
/** The version reason a config save records when the reason field is blank. */
export const EDITED_REASON = 'Edited in the web UI';

/** What the "New agent" dialog asks for; everything else starts from the platform's defaults. */
export interface NewAgentInput {
    readonly name: string;
    readonly role: string;
}

/**
 * The first version of a new agent: its name and role, on the platform
 * runtime (`anthropic-api`, the demo's target) — an API session fails
 * rather than queues when no key is set, so the failure is visible.
 */
export function newAgentPatch(input: NewAgentInput): AgentConfigPatch {
    const patch: { -readonly [K in keyof AgentConfigPatch]: AgentConfigPatch[K] } = { name: input.name.trim(), execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } };
    if (input.role.trim()) patch.role = input.role.trim();
    return patch;
}

/** The form's config as a version patch: every top-level field, so a cleared list clears the stored one. */
export function configPatch(config: AgentConfig): AgentConfigPatch {
    return {
        name: config.name,
        description: config.description,
        role: config.role,
        instructions: config.instructions,
        skills: config.skills,
        tools: config.tools,
        connectors: config.connectors,
        approvalPolicy: config.approvalPolicy,
        memoryPolicy: config.memoryPolicy,
        execution: config.execution,
        collaborators: config.collaborators
    };
}

/**
 * `Agent.get()` + `listVersions()` → the profile the tabs render. The hue
 * and environment line follow the chat directory (`identityOf`), so an agent
 * looks the same on every page; presence, memories and the learning counters
 * wait for the Memory and Session reads (#41) and read as idle / empty here.
 */
export function profileOf(view: AgentView, versions: readonly AgentConfigVersion[], index: number): AgentProfile {
    const identity = identityOf(view, index);
    return {
        id: view.id,
        hue: identity.hue,
        role: view.config.role,
        presence: 'idle',
        environment: identity.environment,
        config: view.config,
        // Newest first, as the rail lists them.
        versions: [...versions].sort((a, b) => b.version - a.version),
        activeOnOlder: 0,
        memories: [],
        scopes: [{ scope: view.memoryScope, shared: false }, ...view.config.memoryPolicy.shared.map((scope) => ({ scope, shared: true }))],
        correctionsThisWeek: 0,
        repeatedMistakes: 0,
        learning: view.config.memoryPolicy.autoLearn !== 'off'
    };
}
