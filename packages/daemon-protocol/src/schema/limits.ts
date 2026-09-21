/**
 * Hard bounds on what a frame may carry. A frame beyond `frameBytes` is
 * refused before it is parsed; the field limits keep a valid-looking frame
 * from smuggling an unbounded payload past the schema.
 */
export const LIMITS = {
    /** Encoded size of one frame (UTF-8 bytes). 1 MiB. */
    frameBytes: 1024 * 1024,
    /** Ids, names, versions, runtime names, tool names. */
    id: 256,
    /** Reasons, messages, labels, paths. */
    text: 4096,
    /** `OpenSpec.system` — instructions + skills + retrieved memory. */
    system: 512 * 1024,
    /** Entries in any list or record (environments, cursors, tools, prompt parts). */
    list: 4096,
    /** Harnesses a daemon reports, and optional features it declares (#360). */
    harnesses: 16,
    /** How long an `update.request` may drain before it restarts anyway: a day (#360). */
    drainTimeoutMs: 24 * 60 * 60 * 1000,
    /** Folders a policy names (#355; core's `POLICY_MAX_ROOTS`), and the length of each. */
    policyRoots: 32,
    policyRoot: 1024,
    /** Lines a `log.request` may ask for and a `log.response` carry (#355; core's `DAEMON_LOG_MAX_LINES`). */
    logLines: 500,
    /** Characters a `login.answer` may carry (#355; core's `LOGIN_ANSWER_MAX_CHARS`). */
    loginAnswer: 2048
} as const;
