/**
 * @agentic/a2a — A2A 1.0 (JSON-RPC binding) both ways: a fetch-handler server
 * that gives every exposed platform agent an Agent Card and tasks over a
 * `SessionPort`, and `a2aAgent()`, a remote A2A agent as an `@sigx/ai-agent`
 * `Agent`. Edge-safe: Web Streams and `fetch`, no `node:` imports.
 */
export const PACKAGE = '@agentic/a2a';

export * from './protocol/index.js';
export * from './server/index.js';
export * from './client/index.js';
