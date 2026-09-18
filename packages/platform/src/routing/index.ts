/** Routing — execution routing: environment selection, offline policy, capacity queue, never a silent switch (architecture §7; EXE-09/11/12, AST-05). */
export { defineRoutingActor, ROUTER, type RoutingActor, type RoutingView } from './actor.js';
export { createSessionFactory, NO_API_KEY_CODE, type SessionFactoryOptions } from './factory.js';
export { ROUTING_TYPE, parseRoutingKey, routingKey } from './key.js';
export { createEnvironmentProbe, locateEnvironment, type EnvironmentProbeOptions, type LocatedEnvironment } from './locate.js';
export type { RoutingPorts } from './ports.js';
export { initialRoutingState, type Route, type RouteStatus, type RoutingState } from './state.js';
export { createToolCallPort, type ToolCallPortOptions } from './tool-call.js';
export { agentChatKey, answerText, createActorToolPorts, type ActorToolPortsOptions, type AgentPrincipal } from './tools.js';
