/**
 * The first-run checklist on Home (#234, PLG-05): while no runtime plugin is
 * ready, the one thing to do next for each runtime that could be — add its
 * key, pair a machine, add an environment on a paired one. Any one of them is
 * enough; the list is gone once a runtime is ready. Pure: the page feeds it
 * the Registry's `overview()`, the readiness `pluginReadiness` computed and
 * the Workspace's machine index.
 */
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { pluginHref } from '../plugins/model';

export interface SetupStep {
    /** The runtime plugin it unblocks (`plugins` for "turn one on"). */
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly href?: string;
    readonly action?: string;
    readonly icon: 'key' | 'machines' | 'plugins' | 'warning';
}

export interface SetupInput {
    readonly plugins: readonly PluginView[];
    readonly readiness: Readonly<Record<string, PluginReadiness>>;
    /** The Workspace's machine index; only paired machines count. */
    readonly machines: readonly { readonly id: string; readonly name: string; readonly status: string }[];
}

/** The steps to show, or `null` when the checklist is not shown: no runtime plugin at all (no catalogue), or one is ready. */
export function setupSteps(input: SetupInput): SetupStep[] | null {
    const runtimes = input.plugins.filter((p) => p.manifest.kind === 'runtime');
    if (!runtimes.length) return null;
    if (runtimes.some((p) => input.readiness[p.manifest.id]?.status === 'ready')) return null;
    const enabled = runtimes.filter((p) => p.enabled);
    if (!enabled.length) {
        return [{ id: 'plugins', title: 'Turn a runtime on', detail: 'Every runtime is turned off, so no agent can start work.', href: '/plugins', action: 'Open plugins', icon: 'plugins' }];
    }
    const paired = input.machines.filter((m) => m.status === 'paired');
    const steps: SetupStep[] = [];
    for (const p of enabled) {
        const r = input.readiness[p.manifest.id];
        const name = p.manifest.name;
        const id = p.manifest.id;
        switch (r?.status) {
            case 'needs-secret':
                steps.push({ id, title: `Add your ${name} key`, detail: `${name} agents run on the platform with your own key. It is stored sealed and opened only to start a session.`, href: pluginHref(id), action: 'Add the key', icon: 'key' });
                break;
            case 'needs-machine': {
                const first = paired[0];
                steps.push(
                    first
                        ? { id, title: 'Add an environment', detail: `${first.name} is paired but offers no ${name} environment yet.`, href: `/machines/${encodeURIComponent(first.id)}`, action: 'Open the machine', icon: 'machines' }
                        : { id, title: 'Pair a machine', detail: `${name} runs on one of your computers, signed in there; its credentials never leave it.`, href: '/pair', action: 'Pair a machine', icon: 'machines' }
                );
                break;
            }
            case 'no-kek':
                steps.push({ id, title: 'This deployment cannot store keys', detail: `${name} needs a stored key, and the Worker has no WORKSPACE_KEK to seal it with (runbook §2.4).`, icon: 'warning' });
                break;
            case undefined:
            case 'ready':
            case 'disabled':
                break;
            default:
                steps.push({ id, title: `Finish setting up ${name}`, detail: `${name} needs its settings or permissions before it can run work.`, href: pluginHref(id), action: 'Open its page', icon: 'plugins' });
        }
    }
    return steps;
}
