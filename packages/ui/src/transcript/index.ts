/**
 * The chat-modes transcript parts (#1054, CHT-09): the steps box a turn's tool calls fold into
 * (`Steps`), the live line under the last turn (`LiveLine`), their `ai-*` anatomies and the pure
 * helpers — styled to `docs/design/chat-modes/HANDOFF.md` → "Chat modes".
 */
export { aiStepsAnatomy, aiLiveLineAnatomy, STEP_STATES } from './anatomy.js';
export { Steps, Steps as AiSteps } from './Steps.js';
export type { StepsProps, StepHrefFn } from './Steps.js';
export { LiveLine, LiveLine as AiLiveLine, formatElapsed } from './LiveLine.js';
export type { LiveLineProps } from './LiveLine.js';
export { stepsFromToolParts, stepLook, stepDuration, stepResult, formatStepDuration } from './step-model.js';
export type { StepLook, StepLifecycle } from './step-model.js';
