/**
 * The transcript anatomies — five `ai-*` scopes declared with zero's PUBLIC
 * `defineAnatomy`, so the data-only fragment entry (`../fragment`) can import
 * them without loading a single component.
 *
 * Every `data-state` value is a member of zero's governed vocabulary: the
 * kit's `mergeManifests` rejects any other spelling at adoption time. A tool
 * call's lifecycle therefore reads as `loading` (pending, awaiting approval,
 * arguments still streaming) · `active` (running) · `complete` (done) ·
 * `error` (failed, cancelled) · `closed` (denied — the request was
 * dismissed); the human phase is the text of the `status` part. Zero's
 * synonym table itself prescribes the first three (`pending → loading`,
 * `done → complete`, `failed → error`); a lifecycle family of its own is
 * filed upstream as andtii/zero-wip#483.
 */
import { defineAnatomy } from '@sigx/zero/anatomy';

/** The lifecycle states a tool call — and a sub-agent it spawned — can render. */
export const LIFECYCLE_STATES = ['loading', 'active', 'complete', 'error', 'closed'] as const;

/**
 * The transcript container: a `role="log"` root that windows its rows and
 * sticks to the bottom while `data-state="on"`; scrolling up turns it `off`,
 * which reveals the `anchor` ("jump to latest") and freezes the window.
 */
export const aiThreadAnatomy = defineAnatomy('ai-thread', {
    root: { element: 'div', states: ['on', 'off'], tokens: ['color'] },
    /** "Show earlier" — rendered only while rows are windowed away at the top. */
    earlier: { element: 'button', parent: 'root', tokens: ['color', 'radius-selector', 'text'] },
    list: { element: 'ol', parent: 'root' },
    row: { element: 'li', parent: 'list' },
    /** "Jump to latest" — mirrors the root's state; the runtime hides it while following. */
    anchor: { element: 'button', parent: 'root', states: ['on', 'off'], hiddenIn: ['on'], tokens: ['color', 'radius-selector', 'text'] }
});

/**
 * One message row, composed over zero's `Chat`: the root carries the logical
 * side (`end` for the user's own rows), `meta` the attribution badge, `body`
 * the text-like parts and `tools` the tool cards, in reading order.
 */
export const aiMessageAnatomy = defineAnatomy('ai-message', {
    root: { element: 'div', placements: ['start', 'end'], tokens: ['color'] },
    avatar: { element: 'span', parent: 'root', tokens: ['color', 'radius-selector', 'text'] },
    meta: { element: 'span', parent: 'root', tokens: ['text'] },
    body: { element: 'div', parent: 'root', tokens: ['text'] },
    tools: { element: 'div', parent: 'root' },
    footer: { element: 'span', parent: 'root', tokens: ['text'] }
});

/** A tool call card: header (signature + status), collapsible io, error line, the sub-agent it spawned. */
export const aiToolCallAnatomy = defineAnatomy('ai-tool-call', {
    root: { element: 'div', states: LIFECYCLE_STATES, tokens: ['color', 'radius-box', 'text'] },
    header: { element: 'div', parent: 'root', tokens: ['text'] },
    status: { element: 'span', parent: 'header', tokens: ['color', 'text'] },
    input: { element: 'details', parent: 'root', states: ['open', 'closed'], tokens: ['text'] },
    output: { element: 'details', parent: 'root', states: ['open', 'closed'], tokens: ['text'] },
    error: { element: 'p', parent: 'root', tokens: ['color', 'text'] },
    agent: { element: 'div', parent: 'root', states: LIFECYCLE_STATES, tokens: ['color', 'radius-box'] }
});

/** A reasoning block on a native `<details>`: open while it streams, folded once done. */
export const aiReasoningAnatomy = defineAnatomy('ai-reasoning', {
    root: { element: 'details', states: ['open', 'closed'], tokens: ['color', 'radius-box', 'text'] },
    summary: { element: 'summary', parent: 'root', tokens: ['text'] },
    body: { element: 'div', parent: 'root', tokens: ['text'] }
});

/** A permission prompt: what is asked, why, and the four decisions (allow / deny × once / session) as zero Buttons. */
export const aiApprovalAnatomy = defineAnatomy('ai-approval', {
    root: { element: 'div', tokens: ['color', 'radius-box'] },
    title: { element: 'p', parent: 'root', tokens: ['text'] },
    description: { element: 'p', parent: 'root', tokens: ['text'] },
    actions: { element: 'div', parent: 'root' }
});
