/**
 * Codex's tool calls as steps (#1055): `shell` names its command and takes the exit code from its settled output
 * (`{exitCode, output}`); `apply_patch` names the files it changed; `web_search` its query; an MCP call what its
 * input names.
 */
import type { NormalisedStep, StepCall } from '../steps.js';
import { genericTarget, isRecord } from './text.js';

export function codexCliStep(call: StepCall): Partial<NormalisedStep> {
    if (call.name === 'shell') {
        const code = isRecord(call.output) && typeof call.output.exitCode === 'number' ? call.output.exitCode : undefined;
        return { kind: 'command', target: genericTarget(call.input) ?? '', ...(code !== undefined ? { exitCode: code } : {}) };
    }
    if (call.name === 'apply_patch') {
        const changes = isRecord(call.input) && Array.isArray(call.input.changes) ? call.input.changes.filter(isRecord) : [];
        const paths = changes.map((c) => c.path).filter((p): p is string => typeof p === 'string');
        return { kind: 'edit', target: paths.join(', '), ...(paths.length > 1 ? { result: `${paths.length} files` } : {}) };
    }
    return { target: genericTarget(call.input) ?? '' };
}
