/**
 * `createPlatformModelAgent` — a `FrozenAgentConfig` as a running API agent
 * (architecture §5a): `modelAgent` over `@sigx/ai-anthropic`, the platform
 * tools the config grants, a system prompt from the config, priced usage
 * and a capability report. The Session actor opens sessions on `agent`,
 * compiles the policy, and turns `usage` events into Ledger rows with
 * `usageRow`.
 */

import type { AnyTool, LanguageModel, Usage } from '@sigx/ai';
import { modelAgent, type Agent, type TranscriptStore } from '@sigx/ai-agent';
import { anthropic, DEFAULT_ANTHROPIC_MODEL, type AnthropicProviderOptions } from '@sigx/ai-anthropic';
import type { CapabilityReport, FrozenAgentConfig, MemoryEntry, UsageRow } from '@agentic/core';
import { grantedPlatformTools, type PlatformPorts } from '../tools/index.js';
import { anthropicCapabilityReport } from './capabilities.js';
import { costOf, resolvePricing, type ResolvedPricing } from './pricing.js';
import { buildSystemPrompt, type ResolvedSkill } from './system-prompt.js';

export interface PlatformAgentDeps {
    readonly ports: PlatformPorts;
    /** The model to run on; default `anthropic(anthropicOptions).model(config.execution.model)`. Tests pass a `mockModel`. */
    readonly model?: LanguageModel;
    /** Further models a session may switch to (`configure({ model })`). */
    readonly models?: readonly LanguageModel[];
    /** BYO key and client options for the default provider (architecture §5a: keys are user-provided). */
    readonly anthropic?: AnthropicProviderOptions;
    /** Where transcripts live; without one the `SessionRef` carries them. */
    readonly store?: TranscriptStore;
    /** Skill text the platform resolved from the config's `SkillRef`s. */
    readonly skills?: readonly ResolvedSkill[];
    /** Memories retrieved for this session; they become the prompt's memory block. */
    readonly memories?: readonly MemoryEntry[];
    /** Extra tools beyond the platform's (connectors); they are on every session's roster as given. */
    readonly tools?: readonly AnyTool[];
}

export interface PlatformModelAgent {
    readonly agent: Agent;
    readonly config: FrozenAgentConfig;
    readonly modelId: string;
    readonly system: string;
    /** The tools every session of this agent gets, in roster order. */
    readonly tools: readonly AnyTool[];
    readonly pricing: ResolvedPricing;
    readonly capabilities: CapabilityReport;
    /** A Ledger row from a `usage` or `turn-end` event; estimates are flagged (OPS-07). */
    usageRow(event: { readonly usage?: Usage; readonly costUsd?: number }, at: { readonly sessionId: string; readonly taskId?: string; readonly at: number }): UsageRow;
}

export function createPlatformModelAgent(config: FrozenAgentConfig, deps: PlatformAgentDeps): PlatformModelAgent {
    const model = deps.model ?? anthropic(deps.anthropic).model(config.execution.model ?? DEFAULT_ANTHROPIC_MODEL);
    const modelId = model.modelId;
    const pricing = resolvePricing(modelId);
    const tools: AnyTool[] = [...grantedPlatformTools(deps.ports, config.tools), ...(deps.tools ?? [])];
    const roster = tools.map((t) => t.name);
    const system = buildSystemPrompt({
        config,
        tools: roster,
        ...(deps.skills ? { skills: deps.skills } : {}),
        ...(deps.memories ? { memories: deps.memories } : {})
    });
    const limits = config.execution.limits;
    const agent = modelAgent({
        id: `anthropic-api:${config.agentId}`,
        model,
        ...(deps.models ? { models: deps.models } : {}),
        system,
        tools,
        pricing: (usage) => costOf(usage, pricing.pricing),
        ...(deps.store ? { store: deps.store } : {}),
        ...(limits.maxSteps !== undefined ? { maxSteps: limits.maxSteps } : {})
    });
    return {
        agent,
        config,
        modelId,
        system,
        tools,
        pricing,
        capabilities: anthropicCapabilityReport(config.tools, roster),
        usageRow(event, at) {
            const usage = event.usage ?? {};
            const { inputTokens, outputTokens, ...rest } = usage;
            const costUsd = event.costUsd ?? costOf(usage, pricing.pricing);
            return {
                at: at.at,
                sessionId: at.sessionId,
                agentId: config.agentId,
                ...(at.taskId !== undefined ? { taskId: at.taskId } : {}),
                usage: { ...rest, inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 },
                costUsd,
                estimated: pricing.estimated
            };
        }
    };
}
