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
    list: 4096
} as const;
