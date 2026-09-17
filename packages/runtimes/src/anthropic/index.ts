/** The `anthropic-api` runtime: a platform-managed agent over `modelAgent` and `@sigx/ai-anthropic`. */

export type { PlatformAgentDeps, PlatformModelAgent } from './agent.js';
export { createPlatformModelAgent } from './agent.js';
export type { ModelPricing, ResolvedPricing, PricedUsage } from './pricing.js';
export { ANTHROPIC_PRICING, resolvePricing, costOf, priceUsage, anthropicPricing } from './pricing.js';
export type { ResolvedSkill, SystemPromptInput } from './system-prompt.js';
export { buildSystemPrompt } from './system-prompt.js';
export { anthropicCapabilityReport } from './capabilities.js';
