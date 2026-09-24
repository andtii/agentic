/**
 * One visual per `PluginReadiness` status (core's `pluginReadiness`, PLG-03):
 * the pill's label, tone and dot, and the sentence that says what to do next.
 * A status core gains gets its row here before it reaches a screen.
 */
import type { PluginReadiness, PluginReadinessStatus } from '@agentic/core';
import type { PillSpec } from '../kit/tone.js';

export const READINESS: Record<PluginReadinessStatus, PillSpec> = {
    ready: { tone: 'live', hollow: false, label: 'READY' },
    disabled: { tone: 'dim', hollow: true, label: 'DISABLED' },
    'needs-config': { tone: 'needs-you', hollow: false, label: 'NEEDS SETUP' },
    'needs-secret': { tone: 'needs-you', hollow: false, label: 'NEEDS KEY' },
    'needs-grant': { tone: 'needs-you', hollow: false, label: 'NEEDS PERMISSION' },
    'needs-sign-in': { tone: 'needs-you', hollow: false, label: 'NEEDS SIGN-IN' },
    'needs-machine': { tone: 'needs-you', hollow: false, label: 'NEEDS A MACHINE' },
    'no-kek': { tone: 'failed', hollow: false, label: 'CANNOT STORE KEYS' }
};

const list = (items: readonly string[] | undefined): string => (items?.length ? items.join(', ') : '');

/** What is in the way, in a sentence; `undefined` when nothing is. */
export function readinessDetail(readiness: PluginReadiness): string | undefined {
    const missing = list(readiness.missing);
    switch (readiness.status) {
        case 'ready':
            return undefined;
        case 'disabled':
            return 'Turned off. New work cannot use it; running work finishes.';
        case 'needs-config':
            return missing ? `Settings to fix: ${missing}.` : 'Its settings need attention.';
        case 'needs-secret':
            return missing ? `Not set yet: ${missing}.` : 'A key it needs is not set.';
        case 'needs-grant':
            return missing ? `Declared but not granted: ${missing}.` : 'A permission it declares is not granted.';
        case 'needs-machine':
            return 'No paired machine offers an environment for this runtime.';
        case 'no-kek':
            return 'This deployment has no WORKSPACE_KEK, so keys cannot be stored.';
    }
}
