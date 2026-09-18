/**
 * Which sign-in doors this deployment has open (#143) — what the shell's
 * signed-out state offers: the GitHub OAuth login when its app is
 * configured, the dev login while `AGENTIC_DEV_LOGIN` is set (local,
 * preview). The Worker records it from its env at the top of every request
 * (`entry.cloudflare.ts`), and the `signInOptions` server function reads
 * it — SSR'd into the document, so the shell knows on first paint and never
 * refetches. Nothing else: no secret leaves this module.
 */
export interface SignInOptions {
    /** `GET /auth/login` is mounted (the GitHub OAuth app secrets are set). */
    readonly github: boolean;
    /** `GET /auth/dev-login` is mounted (`AGENTIC_DEV_LOGIN` is set). */
    readonly devLogin: boolean;
}

const NONE: SignInOptions = { github: false, devLogin: false };

let current: SignInOptions = NONE;

/** Record what the Worker's env enables; a same-valued call changes nothing. */
export function setSignInOptions(next: SignInOptions): void {
    if (next.github !== current.github || next.devLogin !== current.devLogin) current = { github: next.github, devLogin: next.devLogin };
}

/** What is mounted right now — `NONE` where no Worker ever told (the mock dev server, tests). */
export const currentSignInOptions = (): SignInOptions => current;
