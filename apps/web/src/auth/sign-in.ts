/**
 * Which sign-in doors this deployment has open (#143) — what the shell's
 * signed-out state offers: the GitHub OAuth login when its app is
 * configured, the dev login while `AGENTIC_DEV_LOGIN` is set (local,
 * preview), and on a Node host (#1016) the local owner's passphrase login
 * once the node is claimed — or, before the claim, a note that the node is
 * unclaimed. The host records it at the top of every request
 * (`entry.cloudflare.ts`, `apps/node/src/host.ts`), and the `signInOptions`
 * server function reads it — SSR'd into the document, so the shell knows on
 * first paint and never refetches. Nothing else: no secret leaves this
 * module (never the claim link).
 */
export interface SignInOptions {
    /** `GET /auth/login` is mounted (the GitHub OAuth app secrets are set). */
    readonly github: boolean;
    /** `GET /auth/dev-login` is mounted (`AGENTIC_DEV_LOGIN` is set). */
    readonly devLogin: boolean;
    /** `GET /auth/local-login` is mounted: a Node host whose local owner has claimed it (#989). Cloudflare: false. */
    readonly localPassphrase: boolean;
    /** A Node host with a local owner store but no owner yet: the claim link `agentic start` printed is the way in. */
    readonly localUnclaimed: boolean;
}

/** What a host records; the local-owner doors default to closed (Cloudflare has none). */
export type SignInDoors = Pick<SignInOptions, 'github' | 'devLogin'> & Partial<Pick<SignInOptions, 'localPassphrase' | 'localUnclaimed'>>;

const NONE: SignInOptions = { github: false, devLogin: false, localPassphrase: false, localUnclaimed: false };

let current: SignInOptions = NONE;

/** Record what the host's env enables; a same-valued call changes nothing. */
export function setSignInOptions(doors: SignInDoors): void {
    const next: SignInOptions = { github: doors.github, devLogin: doors.devLogin, localPassphrase: doors.localPassphrase ?? false, localUnclaimed: doors.localUnclaimed ?? false };
    if (next.github !== current.github || next.devLogin !== current.devLogin || next.localPassphrase !== current.localPassphrase || next.localUnclaimed !== current.localUnclaimed) current = next;
}

/** What is mounted right now — `NONE` where no host ever told (the mock dev server, tests). */
export const currentSignInOptions = (): SignInOptions => current;

/** The Node host's passphrase login (`apps/node/src/local-owner.ts`). */
export const LOCAL_LOGIN_PATH = '/auth/local-login';

/** The passphrase login's link, landing back on `returnTo` (the route's own `safeReturnTo` re-checks it). */
export const localLoginHref = (returnTo: string): string => (returnTo && returnTo !== '/' ? `${LOCAL_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}` : LOCAL_LOGIN_PATH);
