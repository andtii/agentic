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
export * from './plugin-config.js';
export * from './memory.js';
export * from './learning.js';
export * from './principal.js';
export * from './daemon.js';
export * from './release.js';
export * from './runtime.js';
export * from './usage.js';
export * from './quota.js';
export * from './telemetry.js';
export * from './session-options.js';
export * from './workspace.js';
export * from './workdir.js';
export * from './workspace-source.js';
export * from './project.js';
export * from './project-ui.js';
export * from './work.js';
export * from './pull.js';

// slot #748 plan + refs exports — replace this line

// slot #757 requests exports — replace this line

export * from './account.js';
export * from './files.js';
