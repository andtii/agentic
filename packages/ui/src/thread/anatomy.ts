/**
 * The transcript anatomies — five `ai-*` scopes declared with zero's PUBLIC
 * `defineAnatomy`, so the data-only fragment entry (`../fragment`) can import
 * them without loading a single component.
 *
 * Every `data-state` value is a member of zero's governed vocabulary: the
 * kit's `mergeManifests` rejects any other spelling at adoption time. A tool
 * call's lifecycle reads on zero's governed lifecycle family: `loading`
 * (pending, awaiting approval, arguments still streaming) · `running` ·
 * `paused` (a sub-agent held) · `complete` (done) · `error` (failed) ·
 * `denied` (the request was refused) · `cancelled` (stopped before it
 * finished); the human phase is the pill in the `status` part.
 *
 * The parts follow `docs/design/HANDOFF.md` → "`ai-*` fragment": the
 * message meta carries the environment line and the time, the tool card an
 * icon, a name, a signature and an optional meta, the approval card a
 * header, the request well, the context rows, the actions and the decision
 * record.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/** The lifecycle states a tool call — and a sub-agent it spawned — can render. */
export const LIFECYCLE_STATES = ['loading', 'running', 'paused', 'complete', 'error', 'denied', 'cancelled'] as const;

/**
 * The transcript container: a `role="log"` root that windows its rows and
 * sticks to the bottom while `data-state="on"`; scrolling up turns it `off`,
 * which reveals the `anchor` ("jump to latest") and freezes the window.
 */
export const aiThreadAnatomy = defineAnatomy('ai-thread', {
    root: { element: 'div', states: ['on', 'off'], tokens: ['color'] },
    /** "Showing the last N entries · Load earlier" — rendered while rows are windowed away at the top, or while the host says it holds earlier ones (`hasEarlier`). */
    earlier: { element: 'button', parent: 'root', tokens: ['color', 'radius-selector', 'text'] },
    list: { element: 'ol', parent: 'root' },
    row: { element: 'li', parent: 'list' },
    /** "Jump to latest" — mirrors the root's state; the runtime hides it while following. */
    anchor: { element: 'button', parent: 'root', states: ['on', 'off'], hiddenIn: ['on'], tokens: ['color', 'radius-selector', 'text'] }
});

/**
 * One message row: the avatar tile top-aligned, then a column of `meta`
 * (name, environment line, time, the STREAMING pill while the session is
 * mid-turn), `body` and `tools` runs in reading order, and a `footer` when
 * the row shows a slice of a long message. The root carries the logical
 * side (`end` for the user's own rows). Attachments sit in the body: an
 * `image` thumbnail link and a `file` download chip.
 */
export const aiMessageAnatomy = defineAnatomy('ai-message', {
    root: { element: 'div', placements: ['start', 'end'], tokens: ['color'] },
    avatar: { element: 'span', parent: 'root', tokens: ['color', 'radius-selector', 'text'] },
    meta: { element: 'div', parent: 'root', tokens: ['text'] },
    name: { element: 'span', parent: 'meta', tokens: ['text'] },
    /** The author's project — a visiting manager's (#870): a folder-icon chip. */
    project: { element: 'span', parent: 'meta', tokens: ['color', 'radius-selector', 'text'] },
    /** What the author is here (`project manager, visiting`), dim. */
    role: { element: 'span', parent: 'meta', tokens: ['text'] },
    /** `machine / runtime / account` — the kit's env line, dropped from the row below 768 px. */
    environment: { element: 'span', parent: 'meta', tokens: ['text'] },
    time: { element: 'time', parent: 'meta', tokens: ['text'] },
    body: { element: 'div', parent: 'root', tokens: ['text'] },
    /** An image part: a lazy thumbnail (≤ 320 px) that opens full size in a new tab. */
    image: { element: 'a', parent: 'body', tokens: ['color', 'radius-box'] },
    /** A file part: a download chip — icon, `file-name`, `file-size`. */
    file: { element: 'a', parent: 'body', tokens: ['color', 'radius-selector', 'text'] },
    'file-name': { element: 'span', parent: 'file', tokens: ['text'] },
    'file-size': { element: 'span', parent: 'file', tokens: ['color', 'text'] },
    tools: { element: 'div', parent: 'root' },
    footer: { element: 'span', parent: 'root', tokens: ['text'] }
});

/**
 * A tool call card: header (icon in the state colour, tool name, the
 * signature truncated, an optional meta, the status pill), the `input` and
 * `output` blocks — each holds a zero `Collapsible` (the `<details>`), which
 * the recipe styles in context through `composes` — the error line, the
 * sub-agent it spawned. The output well folds past six lines behind `more`,
 * and `log` links out past two hundred.
 */
export const aiToolCallAnatomy = defineAnatomy('ai-tool-call', {
    root: { element: 'div', states: LIFECYCLE_STATES, tokens: ['color', 'radius-box', 'text'] },
    header: { element: 'div', parent: 'root', tokens: ['text'] },
    icon: { element: 'span', parent: 'header', tokens: ['color'] },
    name: { element: 'code', parent: 'header', tokens: ['text'] },
    signature: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    /** Duration, diff stat, task id — whatever the caller knows about the call. */
    meta: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    /** A page's link about the call ("View diff") — `links`, before the meta. */
    link: { element: 'a', parent: 'header', tokens: ['color', 'text'] },
    status: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    input: { element: 'div', parent: 'root', tokens: ['text'] },
    output: { element: 'div', parent: 'root', tokens: ['text'] },
    /** "Show N more lines" — the output well past six lines. */
    more: { element: 'button', parent: 'output', tokens: ['color', 'text'] },
    /** The session log link — an output past two hundred lines. */
    log: { element: 'a', parent: 'output', tokens: ['color', 'text'] },
    error: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    agent: { element: 'div', parent: 'root', states: LIFECYCLE_STATES, tokens: ['color', 'radius-box'] }
});

/**
 * A reasoning block: the `root` holds a zero `Collapsible` (the `<details>`,
 * open while it streams, folded once done); the `summary` text sits in its
 * trigger and the `body` in its panel.
 */
export const aiReasoningAnatomy = defineAnatomy('ai-reasoning', {
    root: { element: 'div', tokens: ['color', 'text'] },
    summary: { element: 'span', parent: 'root', tokens: ['text'] },
    body: { element: 'div', parent: 'root', tokens: ['text'] }
});

/**
 * A permission request as the handoff's approval card: `header` (shield,
 * "Approval needed", the matching rule), the `request` well (tool and
 * input verbatim), the optional `description`, the `context` rows
 * (Requested by, Runs on, Via — dropped by the `compact` modifier), the
 * three `actions` (Allow once, Allow for this session, Deny), and the
 * one-line `record` a decision collapses to.
 */
export const aiApprovalAnatomy = defineAnatomy('ai-approval', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    header: { element: 'div', parent: 'root', tokens: ['text'] },
    title: { element: 'span', parent: 'header', tokens: ['text'] },
    rule: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    request: { element: 'div', parent: 'root', tokens: ['color', 'radius-field', 'text'] },
    description: { element: 'p', parent: 'root', tokens: ['text'] },
    /** Plan mode's way out (#454): the plan the agent asks to carry out, as markdown. */
    plan: { element: 'div', parent: 'root', tokens: ['color', 'radius-field', 'text'] },
    context: { element: 'dl', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' },
    /** The session answer's label at full length, and the short one the phone shows instead ("Mobile specifics"). */
    'label-full': { element: 'span', parent: 'actions', tokens: ['text'] },
    'label-short': { element: 'span', parent: 'actions', tokens: ['text'] },
    record: { element: 'p', parent: 'root', tokens: ['text'] }
});

/**
 * An input request as a question card: the `header` ("Question", who asks),
 * then one `question` per form property — its `label` (the short header),
 * its `prompt` (the question itself), the `options` as toggles (`on` when
 * chosen, with a `hint` line each) and a free-text `other` — the `actions`
 * with the answer button, the kit's `ErrorNote` when the answer did not get
 * through, and the one-line `record` an answered question collapses to. A
 * question whose asker stopped waiting (#285) carries a `note` saying what
 * answering does.
 */
export const aiQuestionAnatomy = defineAnatomy('ai-question', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    header: { element: 'div', parent: 'root', tokens: ['text'] },
    title: { element: 'span', parent: 'header', tokens: ['text'] },
    note: { element: 'p', parent: 'root', tokens: ['text'] },
    question: { element: 'fieldset', parent: 'root', tokens: ['text'] },
    label: { element: 'legend', parent: 'question', tokens: ['text'] },
    prompt: { element: 'p', parent: 'question', tokens: ['text'] },
    options: { element: 'div', parent: 'question' },
    option: { element: 'button', parent: 'options', states: ['on', 'off'], tokens: ['color', 'radius-field', 'text'] },
    hint: { element: 'span', parent: 'option', tokens: ['text'] },
    other: { element: 'textarea', parent: 'question', tokens: ['color', 'radius-field', 'text'] },
    actions: { element: 'div', parent: 'root' },
    record: { element: 'p', parent: 'root', tokens: ['text'] }
});
