/**
 * What a chat member's model and mode rows offer (#453): the models its environment's account reports
 * (`EnvironmentDescriptor.models`), else the runtime plugin's `defaultModel` enum, each by its display name (#517); the permission modes its runtime
 * plugin lists (`defaultPermissionMode`), `bypassPermissions` only where the environment allows it. Pure.
 */
import { BYPASS_PERMISSIONS_MODE, type ModelOption, type PluginManifest, type RuntimeId } from '@agentic/core';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { modelDisplayName, type WorkdirEnvironment } from '@agentic/ui';

/** One entry of a member's listbox. */
export interface MemberChoice {
    readonly id: string;
    readonly label: string;
    readonly hint?: string;
}

/** The mode a member runs in when nothing names one: the runtime's own. */
export const DEFAULT_PERMISSION_MODE = 'default';

/** What each Claude Code permission mode does, in the listbox's hint column. */
const MODE_HINTS: Readonly<Record<string, string>> = {
    default: 'asks before tools',
    acceptEdits: 'edits without asking',
    plan: 'plans, changes nothing',
    dontAsk: 'only pre-approved tools',
    auto: 'a classifier decides',
    bypassPermissions: 'asks about nothing'
};

function enumOf(runtime: RuntimeId, key: string, plugins: readonly PluginManifest[]): readonly string[] {
    const prop = plugins.find((p) => p.id === runtime)?.config.properties?.[key];
    return prop && prop.type === 'string' && prop.enum ? prop.enum : [];
}

/** The models a member on `runtime` may switch to: its environment's, else the plugin's; `current` is always one of them. */
export function modelChoices(runtime: RuntimeId, env: Pick<WorkdirEnvironment, 'models'> | undefined, current: string | undefined, plugins: readonly PluginManifest[] = RUNTIME_PLUGINS): MemberChoice[] {
    const reported: readonly ModelOption[] = env?.models?.length ? env.models : enumOf(runtime, 'defaultModel', plugins).map((id) => ({ id }));
    // Named as a person reads it (#517): `Opus 5.5`, the id it runs as beside it.
    const choice = (id: string, m?: ModelOption): MemberChoice => {
        const label = modelDisplayName(id, m);
        return { id, label, ...(label !== id ? { hint: id } : {}) };
    };
    const out: MemberChoice[] = reported.map((m) => choice(m.id, m));
    if (current && !out.some((m) => m.id === current)) out.unshift(choice(current));
    return out;
}

/** The permission modes a member on `runtime` may switch to; none when its runtime has no modes. */
export function modeChoices(runtime: RuntimeId, env: Pick<WorkdirEnvironment, 'allowBypassPermissions'> | undefined, plugins: readonly PluginManifest[] = RUNTIME_PLUGINS): MemberChoice[] {
    return enumOf(runtime, 'defaultPermissionMode', plugins)
        .filter((mode) => mode !== BYPASS_PERMISSIONS_MODE || env?.allowBypassPermissions)
        .map((mode) => ({ id: mode, label: mode, ...(MODE_HINTS[mode] ? { hint: MODE_HINTS[mode] } : {}) }));
}
