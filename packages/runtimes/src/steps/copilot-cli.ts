/**
 * Copilot's tool calls as steps (#1055): the kind from `categoryOf` over the tool name (the adapter's own category
 * wins when it set one), the target from what the input names.
 */
import { stepKindOf } from '@agentic/core';
import { categoryOf } from '@sigx/ai-agent/coding';
import type { NormalisedStep, StepCall } from '../steps.js';
import { genericTarget } from './text.js';

export function copilotCliStep(call: StepCall): Partial<NormalisedStep> {
    return { kind: stepKindOf(call.category ?? categoryOf(call.name), call.name), target: genericTarget(call.input) ?? '' };
}
