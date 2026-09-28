/**
 * The chat-modes transcript anatomies (#1054, CHT-09; `docs/design/chat-modes/HANDOFF.md` → "Chat modes"):
 * the steps box a turn's tool calls fold into, and the live line under the last turn. Declared with
 * zero's public `defineAnatomy`, so the data-only fragment entry imports them without loading a
 * component. Every `data-state` value is from zero's governed vocabulary (`LIFECYCLE_STATES`); the
 * product tones stay off `data-state`.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/**
 * A step's `data-state`: the governed lifecycle subset a `TranscriptStep` maps onto, one to one with
 * `ai-tool-call` — `complete` (done), `running`, `error` (failed), `loading` (pending on an open
 * approval) and `denied` (denied or skipped).
 */
export const STEP_STATES = ['loading', 'running', 'complete', 'error', 'denied'] as const;

/**
 * The steps box: the 32 px `summary` button (chevron, the `label` from `formatStepSummary`, the
 * `total` time), then, open, the `list` of 28 px `step` lines — `icon`, `tool`, `target`, `result`,
 * `duration` on the `16px 46px minmax(0,1fr) auto 44px` grid — and under a failed step its
 * `excerpt`: the picked lines, the `excerpt-meta` note and the `full` output link.
 */
export const aiStepsAnatomy = defineAnatomy('ai-steps', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    summary: { element: 'button', parent: 'root', tokens: ['color', 'text'] },
    label: { element: 'span', parent: 'summary', tokens: ['text'] },
    total: { element: 'span', parent: 'summary', tokens: ['color', 'text'] },
    list: { element: 'ol', parent: 'root', tokens: ['color'] },
    step: { element: 'li', parent: 'list', states: STEP_STATES, tokens: ['color', 'text'] },
    icon: { element: 'span', parent: 'step', tokens: ['color'] },
    tool: { element: 'span', parent: 'step', tokens: ['color', 'text'] },
    target: { element: 'span', parent: 'step', tokens: ['color', 'text'] },
    result: { element: 'span', parent: 'step', tokens: ['color', 'text'] },
    duration: { element: 'span', parent: 'step', tokens: ['color', 'text'] },
    excerpt: { element: 'div', parent: 'step', tokens: ['color', 'radius-field', 'text'] },
    'excerpt-meta': { element: 'div', parent: 'excerpt', tokens: ['color', 'text'] },
    full: { element: 'a', parent: 'excerpt-meta', tokens: ['color', 'text'] }
});

/** The 44 px live line under the last turn: `spinner`, the `agent` (tile and name), the current `step`, the `elapsed` time and `Stop`. */
export const aiLiveLineAnatomy = defineAnatomy('ai-live-line', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    spinner: { element: 'span', parent: 'root', tokens: ['color'] },
    agent: { element: 'span', parent: 'root', tokens: ['text'] },
    step: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    elapsed: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    stop: { element: 'span', parent: 'root' }
});
