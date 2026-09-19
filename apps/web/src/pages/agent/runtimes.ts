/**
 * The runtimes an agent can be put on (#234, AGT-02 / AGT-05): the
 * workspace's enabled `runtime` plugins, each saying why it cannot run work
 * yet (core's `pluginReadiness`) and naming the models its plugin lists
 * (a `defaultModel` enum in its config schema). Pure: the agent form's
 * options, the new-agent dialog's and the Home checklist all come from here.
 */
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { readinessDetail, type RuntimeOption } from '@agentic/ui';
import { pluginHref } from '../plugins/model';

/** The plugin's model list: a `defaultModel` string property with an `enum` in its config schema. */
export function modelsOf(plugin: PluginView): readonly string[] {
    const prop = plugin.manifest.config.properties?.['defaultModel'];
    return prop && prop.type === 'string' && prop.enum ? prop.enum : [];
}

/** Where a person fixes what `readiness` says is in the way. */
export function fixFor(plugin: PluginView, readiness: PluginReadiness | undefined): { readonly href: string; readonly hrefLabel: string } {
    if (readiness?.status === 'needs-machine') return { href: '/pair', hrefLabel: 'Pair a machine' };
    if (readiness?.status === 'needs-secret') return { href: pluginHref(plugin.manifest.id), hrefLabel: 'Add the key' };
    if (readiness?.status === 'disabled') return { href: pluginHref(plugin.manifest.id), hrefLabel: 'Turn it on' };
    return { href: pluginHref(plugin.manifest.id), hrefLabel: 'Set it up' };
}

function optionOf(plugin: PluginView, readiness: PluginReadiness | undefined): RuntimeOption {
    const models = modelsOf(plugin);
    const defaultModel = typeof plugin.config['defaultModel'] === 'string' ? (plugin.config['defaultModel'] as string) : undefined;
    const ready = !readiness || readiness.status === 'ready';
    const detail = readiness && !ready ? readinessDetail(readiness) : undefined;
    return {
        value: plugin.manifest.id,
        label: ready ? plugin.manifest.name : `${plugin.manifest.name} — ${notReadyLabel(readiness!)}`,
        ...(detail ? { hint: detail, ...fixFor(plugin, readiness) } : {}),
        ...(models.length ? { models } : {}),
        ...(defaultModel ? { defaultModel } : {})
    };
}

function notReadyLabel(readiness: PluginReadiness): string {
    switch (readiness.status) {
        case 'needs-secret':
            return 'needs a key';
        case 'needs-machine':
            return 'needs a machine';
        case 'disabled':
            return 'turned off';
        case 'no-kek':
            return 'cannot store keys';
        default:
            return 'needs setup';
    }
}

/**
 * The form's runtime options: every ENABLED runtime plugin (a disabled one is
 * not offered), unready ones with their hint. The agent's `current` runtime
 * always stays in the list — marked when it is turned off or no plugin
 * provides it — so the form never switches it silently (EXE-12).
 * `undefined` when the Registry lists no runtime plugin at all (no catalogue
 * behind it): the form keeps its own two.
 */
export function runtimeOptions(plugins: readonly PluginView[], readiness: Readonly<Record<string, PluginReadiness>>, current?: string): RuntimeOption[] | undefined {
    const runtimes = plugins.filter((p) => p.manifest.kind === 'runtime');
    if (!runtimes.length) return undefined;
    const options = runtimes.filter((p) => p.enabled).map((p) => optionOf(p, readiness[p.manifest.id]));
    if (current && !options.some((o) => o.value === current)) {
        const plugin = runtimes.find((p) => p.manifest.id === current);
        options.push(
            plugin
                ? { ...optionOf(plugin, { status: 'disabled' }), hint: 'This runtime is turned off: new work for this agent fails until it is turned back on or you pick another.' }
                : { value: current, label: `${current} — not installed`, hint: 'No plugin in this build provides this runtime: new work for this agent fails until you pick another.', href: '/plugins', hrefLabel: 'See plugins' }
        );
    }
    return options;
}

/** The runtime a new agent starts on: the workspace default when it is offered, else the first ready one, else the first. */
export function initialRuntime(options: readonly RuntimeOption[], workspaceDefault: string | undefined): string {
    if (workspaceDefault && options.some((o) => o.value === workspaceDefault)) return workspaceDefault;
    return (options.find((o) => !o.hint) ?? options[0])?.value ?? workspaceDefault ?? 'anthropic-api';
}
