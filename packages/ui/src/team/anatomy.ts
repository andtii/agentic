/**
 * The chat-modes team anatomies (#1057, CHT-09, COL-09; `docs/design/chat-modes/HANDOFF.md` →
 * "Team", "Lanes"): the crew strip, the handoff line, the work card, folded talk, the lane and the
 * follow panel. Declared with zero's public `defineAnatomy`, so the data-only fragment entry imports
 * them without loading a component.
 *
 * A member's state rides `data-state` on the governed lifecycle subset `TEAM_STATES` (`crewLifecycle`
 * maps the product words onto it); a chip's selection is the `selected` flag. Step lines inside a
 * card, a lane or the panel are `ai-steps` step lines, reused as they are.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/**
 * A member's `data-state`: `running` (working), `loading` (waits on you), `paused` (idle, waiting on
 * others), `complete` (done) and `error` (failed).
 */
export const TEAM_STATES = ['running', 'loading', 'paused', 'complete', 'error'] as const;

/**
 * The crew strip: a 4-column grid of `chip` buttons (sideways scroll on the phone). A chip's first
 * line is the `tile`, the `name`, the state `mark` and the `elapsed` time; its second the current
 * `step`, or the `ask` (`asks you: …`) of a member waiting on you.
 */
export const aiCrewAnatomy = defineAnatomy('ai-crew', {
    root: { element: 'div', tokens: ['color'] },
    chip: { element: 'button', parent: 'root', states: TEAM_STATES, flags: ['selected'], tokens: ['color', 'radius-box', 'text'] },
    name: { element: 'span', parent: 'chip', tokens: ['text'] },
    mark: { element: 'span', parent: 'chip', tokens: ['color'] },
    elapsed: { element: 'span', parent: 'chip', tokens: ['color', 'text'] },
    step: { element: 'span', parent: 'chip', tokens: ['color', 'text'] },
    ask: { element: 'span', parent: 'chip', tokens: ['color', 'text'] }
});

/** The 24 px handoff row: send `icon`, the `from` agent, a `chevron`, the `to` agent, the `task` and the item `ref` chip. */
export const aiHandoffAnatomy = defineAnatomy('ai-handoff', {
    root: { element: 'div', tokens: ['color', 'text'] },
    icon: { element: 'span', parent: 'root', tokens: ['color'] },
    from: { element: 'span', parent: 'root', tokens: ['text'] },
    chevron: { element: 'span', parent: 'root', tokens: ['color'] },
    to: { element: 'span', parent: 'root', tokens: ['text'] },
    task: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    ref: { element: 'span', parent: 'root', tokens: ['color', 'radius-selector', 'text'] }
});

/**
 * One agent's card per assignment: the `head` (tile, `name`, state `mark`, `task`, `meta`
 * `23 steps · 4m 12s`, `follow`), then the last steps while it works or the `result` prose once done.
 */
export const aiWorkCardAnatomy = defineAnatomy('ai-work-card', {
    root: { element: 'article', states: TEAM_STATES, tokens: ['color', 'radius-box'] },
    head: { element: 'div', parent: 'root', tokens: ['color'] },
    name: { element: 'span', parent: 'head', tokens: ['text'] },
    mark: { element: 'span', parent: 'head', tokens: ['color'] },
    task: { element: 'span', parent: 'head', tokens: ['color', 'text'] },
    meta: { element: 'span', parent: 'head', tokens: ['color', 'text'] },
    follow: { element: 'span', parent: 'head' },
    result: { element: 'div', parent: 'root', tokens: ['color', 'text'] }
});

/** The centred divider agent-to-agent talk folds into: `Forge and Lint exchanged 4 messages · show`. */
export const aiFoldedTalkAnatomy = defineAnatomy('ai-folded-talk', {
    root: { element: 'div', tokens: ['color'] },
    label: { element: 'span', parent: 'root', tokens: ['color', 'text'] },
    show: { element: 'button', parent: 'root', tokens: ['color', 'text'] }
});

/**
 * One agent's column in Lanes: the `head` (tile, `name`, `mark`, `elapsed`, then the `task`), the
 * `body` of steps and 12 px `message` boxes (with an optional `to` label), and a `footer` — the done
 * note, or the `question` with its answer buttons on a `needs-you` tint.
 */
export const aiLaneAnatomy = defineAnatomy('ai-lane', {
    root: { element: 'section', states: TEAM_STATES, tokens: ['color', 'radius-box'] },
    head: { element: 'header', parent: 'root', tokens: ['color'] },
    name: { element: 'span', parent: 'head', tokens: ['text'] },
    mark: { element: 'span', parent: 'head', tokens: ['color'] },
    elapsed: { element: 'span', parent: 'head', tokens: ['color', 'text'] },
    task: { element: 'div', parent: 'head', tokens: ['color', 'text'] },
    body: { element: 'div', parent: 'root' },
    message: { element: 'div', parent: 'body', tokens: ['color', 'radius-field', 'text'] },
    to: { element: 'div', parent: 'message', tokens: ['color', 'text'] },
    footer: { element: 'footer', parent: 'root', tokens: ['color', 'text'] },
    question: { element: 'footer', parent: 'root', tokens: ['color', 'text'] },
    answers: { element: 'div', parent: 'question' }
});

/**
 * The 330 px follow panel: the `head` (`title`, close), the `task` and `env` line, `label`led
 * sections for the last steps and the live `output` (a `pre` ending in a `cursor`), the `result`
 * once done, the `actions` (`Message X`, `Stop`) and the `note`.
 */
export const aiFollowAnatomy = defineAnatomy('ai-follow', {
    root: { element: 'aside', tokens: ['color', 'radius-box'] },
    head: { element: 'div', parent: 'root' },
    title: { element: 'h2', parent: 'head', tokens: ['text'] },
    task: { element: 'div', parent: 'root', tokens: ['text'] },
    env: { element: 'div', parent: 'root', tokens: ['color', 'text'] },
    label: { element: 'h3', parent: 'root', tokens: ['color', 'text'] },
    output: { element: 'pre', parent: 'root', tokens: ['color', 'radius-field', 'text'] },
    cursor: { element: 'span', parent: 'output', tokens: ['color'] },
    result: { element: 'div', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' },
    note: { element: 'p', parent: 'root', tokens: ['color', 'text'] }
});

export const teamAnatomies = [aiCrewAnatomy, aiHandoffAnatomy, aiWorkCardAnatomy, aiFoldedTalkAnatomy, aiLaneAnatomy, aiFollowAnatomy];
