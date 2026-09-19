/**
 * The enable switch on the live plugin pages (#233; AC-13): `Registry.enable`
 * / `disable`, with the switch held at the Registry's value until the
 * Registry answers. Turning a plugin off first asks who depends on it
 * (`dependentsAll`, one read) and confirms by name when someone does, when
 * the whole workspace runs on it, or when it is the last runtime that is
 * ready; the disable itself always succeeds and answers with what it leaves
 * behind, which the page then states.
 */
import { effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import type { PluginReadiness } from '@agentic/core';
import type { Dependents, PluginView } from '@agentic/platform';
import { ConfirmDialog, Switch } from '@agentic/ui';
import type { ActorDefs } from '../../actors/defs';
import { dependentCount, dependentNames, disableLabel } from '../ops/live';
import { disableDescription, isLastReadyRuntime, needsConfirm, registryErrorText } from './model';

interface Confirming {
    readonly plugin: PluginView;
    readonly dependents: Dependents | undefined;
    readonly lastRuntime: boolean;
}

export interface PluginSwitchesOptions {
    readonly defs: Pick<ActorDefs, 'Registry'>;
    /** The Registry's key, or `null` while signed out. */
    readonly key: () => string | null;
    readonly plugins: () => readonly PluginView[];
    readonly readiness: () => Readonly<Record<string, PluginReadiness>>;
    readonly agentName: (id: string) => string;
    /** After a disable or an enable landed — the page re-reads its dependents. */
    readonly onChanged?: () => void;
}

export interface PluginSwitches {
    /** The switch of one plugin. */
    switchFor(plugin: PluginView): JSXElement;
    /** The confirm dialog, while one is open. */
    dialog(): JSXElement | null;
    /** What each plugin disabled on this visit still leaves referencing it. */
    left(): Readonly<Record<string, Dependents>>;
    error(): string;
}

export function usePluginSwitches(options: PluginSwitchesOptions): PluginSwitches {
    const { defs } = options;
    const st = signal<{ busy: string | null; error: string; confirming: Confirming | null; left: Record<string, Dependents> }>({ busy: null, error: '', confirming: null, left: {} });
    // The switches' own state, following the Registry: a switch held while the dialog decides does not flip until the actor says so.
    const enabled = signal<Record<string, boolean>>({});
    const seen: Record<string, boolean> = {};
    const stopSync = effect(() => {
        for (const p of options.plugins()) {
            const id = p.manifest.id;
            if (seen[id] !== p.enabled) {
                seen[id] = p.enabled;
                enabled[id] = p.enabled;
            }
        }
    });
    onUnmounted(stopSync);

    /** The switch goes back to what the Registry last said — a call that failed changed nothing. */
    const revert = (id: string): void => {
        if (seen[id] !== undefined) enabled[id] = seen[id];
    };
    const fail = (id: string, e: unknown): void => {
        revert(id);
        st.error = registryErrorText(e);
    };

    const disable = async (plugin: PluginView): Promise<void> => {
        const k = options.key();
        const id = plugin.manifest.id;
        if (!k) return;
        st.busy = id;
        st.error = '';
        try {
            const { dependents } = await actor(defs.Registry, k).disable(id);
            st.left = { ...st.left, [id]: dependents };
            options.onChanged?.();
        } catch (e) {
            fail(id, e);
        } finally {
            st.busy = null;
        }
    };

    const toggle = async (plugin: PluginView, next: boolean): Promise<void> => {
        const k = options.key();
        const id = plugin.manifest.id;
        // The switch holds at the Registry's value until the Registry answers.
        revert(id);
        if (!k || st.busy) return;
        st.error = '';
        st.busy = id;
        try {
            if (next) {
                await actor(defs.Registry, k).enable(id);
                const { [id]: _gone, ...rest } = st.left;
                void _gone;
                st.left = rest;
                options.onChanged?.();
                return;
            }
            // Off: ask who depends on it first; the dialog decides.
            const dependents = (await actor(defs.Registry, k).dependentsAll()).find((d) => d.pluginId === id);
            const lastRuntime = isLastReadyRuntime(plugin, options.readiness(), options.plugins());
            st.busy = null;
            if (needsConfirm(dependents) || lastRuntime) st.confirming = { plugin, dependents, lastRuntime };
            else await disable(plugin);
        } catch (e) {
            fail(id, e);
        } finally {
            if (st.busy === id) st.busy = null;
        }
    };

    const confirmDisable = (): void => {
        const c = st.confirming;
        st.confirming = null;
        if (c) void disable(c.plugin);
    };

    return {
        switchFor: (plugin) => {
            const id = plugin.manifest.id;
            return <Switch label={`Enable ${plugin.manifest.name}`} hideLabel model={() => enabled[id]} disabled={st.busy === id} onCheckedChange={(v: boolean) => { void toggle(plugin, v); }} />;
        },
        dialog: () => {
            const c = st.confirming;
            if (!c) return null;
            const names = c.dependents ? dependentNames(c.dependents, options.agentName) : [];
            return (
                <ConfirmDialog
                    model={() => st.confirming !== null}
                    title={`Disable ${c.plugin.manifest.name}?`}
                    description={disableDescription(c.plugin, c.dependents, c.lastRuntime)}
                    {...(names.length ? { dependents: names, dependentsLabel: `Depends on it · ${dependentCount(c.dependents!)}` } : {})}
                    confirmLabel={disableLabel(c.plugin)}
                    cancelLabel="Keep enabled"
                    onConfirm={confirmDisable}
                    onCancel={() => { st.confirming = null; }}
                />
            );
        },
        left: () => st.left,
        error: () => st.error
    };
}
