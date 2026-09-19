/** The A2A client: a remote agent as an `Agent`, its sessions, and the JSON-RPC/SSE transport. */

export type { A2aAgent, A2aAgentOptions, A2aSupport } from './agent.js';
export { a2aAgent, capabilitiesFrom, supportFrom, jsonRpcInterface, A2A_BASE_CAPABILITIES, A2A_UNSUPPORTED } from './agent.js';
export type { A2aSessionOptions, OpenA2aSessionOptions } from './session.js';
export { openA2aSession } from './session.js';
export type { A2aRpcClient, A2aTransportOptions, FetchLike } from './transport.js';
export { createA2aRpcClient, fetchAgentCard, cardUrlFor, sseData } from './transport.js';
export type { A2aPeerOpenContext, A2aPeerOptions, A2aPeerPluginAccess, A2aPeerRuntimeOptions } from './peer.js';
export { a2aPeer, a2aPeerId, a2aPeerIdFrom, a2aPeerRuntime, a2aPeerTokenSecret, isA2aPeerRuntime, A2A_PEER_CAPABILITIES, A2A_PEER_PREFIX, A2A_PEER_VERSION } from './peer.js';
