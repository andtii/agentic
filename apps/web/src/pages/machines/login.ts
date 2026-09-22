/**
 * Sign-in from the Machine page (#484): the pure half of the login dialog
 * over `Machine.requestLogin` / `answerLogin` / `cancelLogin` / `loginState`
 * — which environments the daemon can sign in from here (its capability says
 * `login: 'relay'`), how each phase reads, how a failure reads.
 */
import type { CapabilityReport, DaemonFeature, EnvironmentDescriptor, LoginAction, LoginError, LoginPhase } from '@agentic/core';

/** What the page shows of a relayed sign-in: `loginState`'s view, or the page's own refusal before one started. */
export interface LoginView {
    readonly phase: LoginPhase;
    readonly action?: LoginAction;
    readonly error?: LoginError | { readonly code: 'machine-offline' | 'internal'; readonly message: string };
}

/** The daemon relays this environment's sign-in: the `login` feature, and its runtime's capability says `relay`. */
export function loginRelayable(env: Pick<EnvironmentDescriptor, 'runtime'>, capabilities: readonly CapabilityReport[] | undefined, features: readonly DaemonFeature[] | undefined): boolean {
    return features?.includes('login') === true && capabilities?.find((c) => c.runtime === env.runtime)?.login === 'relay';
}

/** The line above the action, per phase. */
export function loginPhaseText(view: LoginView | null, machineName: string): string {
    if (!view) return `Starting the sign-in on ${machineName}…`;
    switch (view.phase) {
        case 'started':
            return `The runtime's sign-in is starting on ${machineName}…`;
        case 'action':
        case 'waiting':
            return view.action?.kind === 'device-code'
                ? 'Open the link in any browser, sign in, and enter this code there. The runtime notices on its own.'
                : view.action?.expectsPaste
                    ? 'Open the link in any browser and sign in; paste the code it shows you back here.'
                    : 'Open the link in any browser and sign in. The runtime notices on its own.';
        case 'done':
            return 'Signed in. The environment reports its account in a moment.';
        case 'failed':
            return 'The sign-in did not complete.';
    }
}

/** Why a sign-in ended, as a sentence. */
export function loginErrorText(error: NonNullable<LoginView['error']>): string {
    const detail = error.message ? ` ${error.message}` : '';
    switch (error.code) {
        case 'busy':
            return 'A sign-in is already running for this environment. Cancel it first, or wait for it to end.';
        case 'unknown-environment':
            return 'The machine no longer has this environment.';
        case 'unsupported':
            return `This runtime is signed in on the machine.${detail}`;
        case 'cancelled':
            return 'The sign-in was cancelled.';
        case 'timeout':
            return 'The sign-in was not completed in time. Start it again.';
        case 'machine-offline':
            return 'The machine is offline. An account can be signed in while its daemon is connected.';
        case 'failed':
            return `The runtime refused the sign-in.${detail}`;
        default:
            return error.message || 'Something went wrong.';
    }
}

/** A thrown `requestLogin` / `answerLogin` call as a refusal. */
export function loginCallFailure(e: unknown): NonNullable<LoginView['error']> {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 503) return { code: 'machine-offline', message };
    if (status === 409) return { code: /already running/.test(message) ? 'busy' : 'unsupported', message: message.replace(/^machine: /, '') };
    if (status === 404) return { code: 'unknown-environment', message };
    return { code: 'internal', message };
}
