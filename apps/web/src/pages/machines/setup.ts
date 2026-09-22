/**
 * The setup checklist at the top of the Machine page (#482): Paired →
 * Folders → Environment → Signed in → Ready, each step done, current or
 * still to do, with one action. Pure: the page decides what the action opens.
 */
import type { EnvironmentDescriptor } from '@agentic/core';
import type { PolicyCardState } from './policy';

export type SetupStepId = 'paired' | 'folders' | 'environment' | 'signed-in' | 'ready';

export interface SetupStep {
    readonly id: SetupStepId;
    readonly label: string;
    readonly state: 'done' | 'current' | 'todo';
    /** Under the current step: what is missing, or what a done step has. */
    readonly note: string;
    /** The one thing to do for the current step. */
    readonly action?: string;
}

export interface SetupFacts {
    readonly name: string;
    readonly online: boolean;
    readonly revoked: boolean;
    readonly policy: PolicyCardState;
    /** The daemon reports web management on (whatever set it). */
    readonly webManaged: boolean;
    readonly environments: readonly EnvironmentDescriptor[];
    /** The doctor's verdicts; empty until the daemon reported any. */
    readonly doctor: readonly { readonly ok: boolean }[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The five steps in order; the first not done is `current`, the rest `todo`. */
export function setupSteps(f: SetupFacts): SetupStep[] {
    const signedIn = f.environments.filter((e) => e.account.authStatus === 'ok');
    const failing = f.doctor.filter((c) => !c.ok).length;
    const done: Record<SetupStepId, boolean> = {
        paired: f.online,
        folders: f.webManaged,
        environment: f.environments.length > 0,
        'signed-in': signedIn.length > 0,
        ready: f.doctor.length > 0 && failing === 0
    };
    const steps: Omit<SetupStep, 'state'>[] = [
        {
            id: 'paired',
            label: 'Paired',
            note: f.revoked ? 'Revoked: pair it again to use it.' : f.online ? `${f.name} is online.` : 'Waiting for the daemon to connect — it says hello as soon as it runs.',
            action: 'Rename'
        },
        {
            id: 'folders',
            label: 'Folders',
            note: f.policy === 'no-feature'
                ? 'The daemon predates web-managed folders: allow one on the machine, or reinstall it once.'
                : f.policy === 'locked'
                    ? 'The policy is locked on the machine.'
                    : f.webManaged
                        ? 'The web may add environments inside the allowed folders.'
                        : 'Allow at least one folder the web may use — your home folder, or where your projects live.',
            action: 'Choose folders'
        },
        {
            id: 'environment',
            label: 'Environment',
            note: f.environments.length ? plural(f.environments.length, 'environment', 'environments') : 'Add an environment in a subfolder of an allowed folder: a runtime, its account, the folders agents work in.',
            action: 'Add environment'
        },
        {
            id: 'signed-in',
            label: 'Signed in',
            note: signedIn.length ? `${plural(signedIn.length, 'account', 'accounts')} can authenticate.` : 'Sign an account in on the machine — its login never leaves it.',
            action: 'Show the command'
        },
        {
            id: 'ready',
            label: 'Ready',
            note: f.doctor.length === 0 ? 'Run the doctor to check account isolation.' : failing ? `${plural(failing, 'doctor check', 'doctor checks')} failing.` : 'Every doctor check passes.',
            action: 'Run the doctor'
        }
    ];
    let current = false;
    return steps.map((s) => {
        if (done[s.id]) return { ...s, state: 'done' as const };
        if (!current) {
            current = true;
            return { ...s, state: 'current' as const };
        }
        return { ...s, state: 'todo' as const };
    });
}

/** The step the checklist marks, or `null` when everything is done. */
export const currentStep = (steps: readonly SetupStep[]): SetupStepId | null => steps.find((s) => s.state === 'current')?.id ?? null;
