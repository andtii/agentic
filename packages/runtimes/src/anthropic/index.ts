/** The `anthropic-api` runtime: a platform-managed agent over `modelAgent` and `@sigx/ai-anthropic`. */

export type { PlatformAgentDeps, PlatformModelAgent } from './agent.js';
export { createPlatformModelAgent } from './agent.js';
export type { ModelPricing, ResolvedPricing, PricedUsage } from './pricing.js';
export { ANTHROPIC_PRICING, resolvePricing, costOf, priceUsage, anthropicPricing } from './pricing.js';
export type { ResolvedSkill, SystemPromptInput } from './system-prompt.js';
export { buildSystemPrompt, chatSection } from './system-prompt.js';
export { anthropicCapabilityReport } from './capabilities.js';
export type { ChatTitleInput, ChatTitleMessage } from './title.js';
export { generateChatTitle, chatTitleModel, cleanTitle, titlePrompt, TITLE_MODEL, TITLE_MAX_LENGTH, TITLE_MESSAGE_CHARS, TITLE_SYSTEM_PROMPT } from './title.js';
