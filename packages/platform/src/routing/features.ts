/**
 * Project feature plugins at placement (#332, architecture §7, §9; EXE-12,
 * PLG-01): once the router has the task's folder and before the session
 * opens, every feature the project enables — and this build ships — gets its
 * `beforeSession`, with an `fs` that goes through the environment's daemon
 * (`Machine.fsRequest` / `fsResult`). A returned `cwd` replaces the route's
 * (re-checked against the roots by the caller); `instructions` join every
 * plugin's `instructions()` into the prompt's `## Project` section. A throw
 * parks the task `waiting { project-feature }` with the plugin's message:
 * never a silent fallback.
 */

import { configDefaults, enabledProjectFeatures, FS_RUN_DEFAULT_TIMEOUT_MS, FS_RUN_MAX_TIMEOUT_MS, type ChatId, type EnvironmentId, type FsOp, type ProjectFeatureFs, type ProjectFeaturePlugin, type ProjectRecord, type TaskId } from '@agentic/core';
import { isServerFnError } from '@sigx/server';
import type { FsResultView } from '../machine/index.js';

/** The slice of the Machine actor `machineFs` drives. */
export interface FsMachineClient {
    fsRequest(environmentId: EnvironmentId, op: FsOp): Promise<{ readonly requestId: string }>;
    fsResult(requestId: string): Promise<FsResultView> | FsResultView;
}

export interface MachineFsOptions {
    /** How often `fsResult` is read while the request is pending. Default 250 ms. */
    readonly pollMs?: number;
    /** How long a request may stay pending before `fs` answers `timeout` itself (the Machine's own deadline is 30 s). Default 35 s. */
    readonly timeoutMs?: number;
    readonly now?: () => number;
}

/** The plugin's settings in the project, the manifest's defaults filled in. */
export function featureSettings(plugin: ProjectFeaturePlugin, project: ProjectRecord, id: string): Readonly<Record<string, unknown>> {
    return { ...configDefaults(plugin.manifest.projectSettings), ...project.features[id] };
}

/** An `fs` for the API path: a platform-hosted runtime has no daemon to ask. */
export const noDaemonFs: ProjectFeatureFs = async () => ({ error: { code: 'unsupported', message: 'no daemon on this environment' } });

/**
 * A `ProjectFeatureFs` over one machine's daemon: `fsRequest`, then `fsResult` polled until the daemon answered
 * (or the deadline passed). A refusal of the request itself (offline, unknown environment, not the owner) is the
 * daemon-shaped error the plugin would get from the wire. A `run` (#620) waits its own time on top — a setup command
 * may install for minutes — and is polled at most every `RUN_POLL_MS` once it has run a few seconds.
 */
/** A `run` still going after this long is polled less often… */
const RUN_SLOW_AFTER_MS = 5_000;
/** …at most every this long. */
const RUN_POLL_MS = 2_000;

export function machineFs(machine: FsMachineClient, environmentId: EnvironmentId, options: MachineFsOptions = {}): ProjectFeatureFs {
    const pollMs = options.pollMs ?? 250;
    const timeoutMs = options.timeoutMs ?? 35_000;
    const now = options.now ?? Date.now;
    return async (op) => {
        let requestId: string;
        try {
            ({ requestId } = await machine.fsRequest(environmentId, op));
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const status = isServerFnError(e) ? e.status : undefined;
            return { error: { code: status === 404 ? 'unknown-environment' : status === 400 ? 'internal' : 'unsupported', message } };
        }
        const started = now();
        const deadline = started + timeoutMs + (op.kind === 'run' ? Math.min(op.timeoutMs ?? FS_RUN_DEFAULT_TIMEOUT_MS, FS_RUN_MAX_TIMEOUT_MS) : 0);
        for (;;) {
            let view: FsResultView;
            try {
                view = await machine.fsResult(requestId);
            } catch (e) {
                return { error: { code: 'internal', message: `the answer to ${op.kind} could not be read: ${e instanceof Error ? e.message : String(e)}` } };
            }
            if (view.status === 'done' && view.result) return { result: view.result };
            if (view.status === 'error' || view.status === 'done') return { error: view.error ?? { code: 'internal', message: `the daemon answered ${op.kind} without a result` } };
            if (now() >= deadline) return { error: { code: 'timeout', message: `the daemon did not answer ${op.kind} within ${deadline - started} ms` } };
            await new Promise((r) => setTimeout(r, op.kind === 'run' && now() - started > RUN_SLOW_AFTER_MS ? Math.max(pollMs, RUN_POLL_MS) : pollMs));
        }
    };
}

export interface FeatureHooksInput {
    readonly project: ProjectRecord;
    readonly plugins: Readonly<Record<string, ProjectFeaturePlugin>>;
    readonly taskId: TaskId;
    readonly chatId?: ChatId;
    /** Absent on the API path: a platform-hosted runtime runs in no folder, so `beforeSession` is not called there. */
    readonly environmentId?: EnvironmentId;
    readonly cwd?: string;
    readonly fs: ProjectFeatureFs;
}

export type FeatureHooksOutcome =
    /** Every hook ran: the folder the session opens in (changed by a plugin or not), and the project section's text. */
    | { readonly ok: true; readonly cwd?: string; readonly instructions?: string }
    /** A hook threw: what the task waits with. */
    | { readonly ok: false; readonly pluginId: string; readonly message: string };

/** A hook's message as the wait reason carries it: one line, at most this many characters. */
export const FEATURE_MESSAGE_MAX = 500;

function messageOf(error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim() || 'the plugin gave no reason';
    return text.length > FEATURE_MESSAGE_MAX ? `${text.slice(0, FEATURE_MESSAGE_MAX - 1)}…` : text;
}

/**
 * Run the project's enabled feature plugins for one placement, in the order the project lists them: `beforeSession`
 * (when the session has a folder to run in) and `instructions`. The first throw stops the run — a later `Routing.run`
 * starts it over.
 */
export async function runFeatureHooks(input: FeatureHooksInput): Promise<FeatureHooksOutcome> {
    const { project, plugins } = input;
    const fragments: string[] = [];
    let cwd = input.cwd;
    for (const id of enabledProjectFeatures(project)) {
        // An enabled feature this build does not ship (a plugin removed from the catalogue, another build): skipped, never a failure.
        const plugin = Object.hasOwn(plugins, id) ? plugins[id] : undefined;
        if (!plugin) continue;
        const settings = featureSettings(plugin, project, id);
        try {
            if (plugin.beforeSession && input.environmentId !== undefined && cwd !== undefined) {
                const effect = await plugin.beforeSession({ project, settings, taskId: input.taskId, ...(input.chatId ? { chatId: input.chatId } : {}), environmentId: input.environmentId, cwd, fs: input.fs });
                if (typeof effect?.cwd === 'string' && effect.cwd.trim()) cwd = effect.cwd.trim();
                if (typeof effect?.instructions === 'string' && effect.instructions.trim()) fragments.push(effect.instructions.trim());
            }
            const text = plugin.instructions?.({ project, settings });
            if (typeof text === 'string' && text.trim()) fragments.push(text.trim());
        } catch (error) {
            return { ok: false, pluginId: id, message: messageOf(error) };
        }
    }
    return { ok: true, ...(cwd !== undefined ? { cwd } : {}), ...(fragments.length ? { instructions: fragments.join('\n\n') } : {}) };
}
