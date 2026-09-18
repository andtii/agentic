/**
 * @agentic/core — edge-safe platform contracts. Types plus a few pure helpers;
 * zero dependencies; no `node:` imports. Every other package imports its
 * cross-package types from here (architecture §1).
 */
export const PACKAGE = '@agentic/core';

export * from './ids.js';
export * from './agent.js';
export * from './chat.js';
export * from './task.js';
export * from './environment.js';
export * from './plugin.js';
export * from './memory.js';
export * from './learning.js';
export * from './principal.js';
export * from './daemon.js';
export * from './runtime.js';
export * from './usage.js';
export * from './workspace.js';
export * from './workdir.js';
export * from './files.js';
