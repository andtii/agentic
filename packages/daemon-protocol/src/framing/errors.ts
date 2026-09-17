/** Why a message was refused — every code is named so both ends can log, count and answer it. */

export const FRAME_ERROR_CODES = ['too-large', 'not-json', 'not-object', 'unsupported-version', 'unknown-type', 'invalid'] as const;

export type FrameErrorCode = (typeof FRAME_ERROR_CODES)[number];

export interface FrameIssue {
    /** Dotted path into the frame (`spec.tools.3`), or `''` for the root. */
    readonly path: string;
    readonly message: string;
}

export interface FrameError {
    readonly code: FrameErrorCode;
    readonly message: string;
    /** Field-level detail for `invalid`. */
    readonly issues?: readonly FrameIssue[];
}

export class DaemonProtocolError extends Error {
    override readonly name = 'DaemonProtocolError';
    readonly code: FrameErrorCode;
    readonly issues: readonly FrameIssue[];

    constructor(error: FrameError) {
        super(error.message);
        this.code = error.code;
        this.issues = error.issues ?? [];
    }
}
