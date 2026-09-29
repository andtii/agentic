/**
 * The machines store (#1120): the one owner of each paired machine's live
 * `Machine.get` and of the environment directory folded from them. The paired
 * list is the workspace store's `machines` (`Workspace.listMachines`); every
 * machine's record is fetched once through `useData` (the `['environments', ws,
 * …ids]` key, so the server render carries it) and then kept current by a live
 * `Machine.get` subscription on the app's live channel, diffed as machines are
 * paired and unpaired and closed in `ctx.onDeactivated`. The connection strip,
 * `/machines`, a runtime's "Machines" section, the Limits card and every
 * environment picker read their rows here, so a route change reuses the app's
 * subscriptions instead of redialling each Machine actor.
 *
 * With no actor definitions or viewer provided (a render on mock data), the
 * store reads nothing and every selector answers empty.
 */
import { computed, effect, signal, untrack } from '@sigx/reactivity';
import { useData } from '@sigx/runtime-core';
import { actor, actorKey, type AnyActorDefinition } from '@sigx/actors';
import { useActorsContext, type ActorLiveChannel } from '@sigx/actors/app';
import { accountDirectory, environmentsForAccount, type AccountEntry, type AccountRef, type EnvironmentDescriptor, type HostOs, type QuotaSnapshot, type RuntimeId } from '@agentic/core';
import type { MachineIndexEntry, MachineView } from '@agentic/platform';
import { useActorDefs } from '../defs';
import { useViewer } from '../viewer';
import { defineAppStore } from './define';
import { useWorkspaceStore } from './workspace';

/** One environment as the pickers show it. */
export interface EnvironmentEntry {
    readonly id: string;
    readonly machineId: string;
    readonly machineName: string;
    readonly online: boolean;
    /** What the daemon said in `hello`; absent until it has connected once. Paths follow its rules (#193). */
    readonly os?: HostOs;
    readonly descriptor: EnvironmentDescriptor;
    /** The environment line's three parts (`EnvironmentParts` in `@agentic/ui`). */
    readonly line: { readonly machine: string; readonly runtime: string; readonly account: string };
    /** "alien01 / claude-code / work" — the select's label. */
    readonly label: string;
    /** Its account's provider limits as the machine last reported them (#315); `null` before the first report. */
    readonly quota?: QuotaSnapshot | null;
}

/** One paired machine as the directory lists it (#414): a machine that never connected has no environments yet. */
export interface MachineEntry {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly os?: HostOs;
    readonly environments: readonly EnvironmentDescriptor[];
}

/** A Machine actor's key — the platform's `machineKey`, spelled here so the bundle never imports the platform for a string. */
export const machineKeyOf = (ws: string, id: string): string => `${ws}:machine:${id}`;

/** The paired machines of an index, index order. */
export const pairedOf = (machines: readonly MachineIndexEntry[] | undefined): MachineIndexEntry[] => (machines ?? []).filter((m) => m.status === 'paired');

/** The directory folded from the machines' records, `ids` order; a revoked or unread machine offers nothing. */
export function foldEnvironments(ids: readonly string[], views: Readonly<Record<string, MachineView | undefined>>): { entries: EnvironmentEntry[]; machines: MachineEntry[] } {
    const entries: EnvironmentEntry[] = [];
    const machines: MachineEntry[] = [];
    for (const machineId of ids) {
        const m = views[machineId];
        if (!m || m.revoked) continue;
        machines.push({ id: machineId, name: m.name, online: m.online, ...(m.os ? { os: m.os } : {}), environments: m.environments });
        const own: EnvironmentEntry[] = m.environments.map((d) => ({
            id: d.id,
            machineId,
            machineName: m.name,
            online: m.online,
            ...(m.os ? { os: m.os } : {}),
            descriptor: d,
            line: { machine: m.name, runtime: d.runtime, account: d.account.label },
            label: `${m.name} / ${d.runtime} / ${d.account.label}`,
            quota: m.quota?.[d.id] ?? null
        }));
        entries.push(...own.sort((a, b) => a.id.localeCompare(b.id)));
    }
    return { entries, machines };
}

/** An injectable the app may not provide (a render on mock data): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useMachineStore = defineAppStore('machines', (ctx) => {
    const workspace = useWorkspaceStore();
    // A render without the Machine definition (mock data, a test of another store) reads nothing.
    const Machine = optional(useActorDefs)?.Machine ?? null;
    const viewer = Machine ? optional(() => useViewer()()) : null;
    const ws = (): string | null => viewer?.workspaceId ?? null;
    const paired = computed(() => (Machine && viewer ? pairedOf(workspace.machines) : []));

    // Every paired machine's record, fetched once per paired set (SSR carries it).
    const fetched = useData(
        () => {
            const w = ws();
            const machines = workspace.machines;
            return Machine && w && machines ? (['environments', w, ...pairedOf(machines).map((m) => m.id)] as const) : false;
        },
        async (key): Promise<Record<string, MachineView>> => {
            const [, w, ...ids] = key as readonly [string, string, ...string[]];
            const out: Record<string, MachineView> = {};
            await Promise.all(
                ids.map(async (id) => {
                    try {
                        out[id] = await actor(Machine!, machineKeyOf(w, id)).get();
                    } catch {
                        // Not paired yet, or gone: nothing to show until a frame comes.
                    }
                })
            );
            return out;
        }
    );

    // The live half: one `Machine.get` subscription per paired machine, keyed by actor key so a workspace switch drops every old one.
    const pushed = signal<{ byKey: Record<string, MachineView> }>({ byKey: {} });
    const subs = new Map<string, () => void>();
    const channel: ActorLiveChannel | null = Machine ? useActorsContext().live : null;
    const runner = effect(() => {
        const w = ws();
        const wanted = new Map(w ? paired.value.map((m) => [machineKeyOf(w, m.id), m.id] as const) : []);
        untrack(() => {
            for (const [key, off] of subs) {
                if (wanted.has(key)) continue;
                off();
                subs.delete(key);
            }
            if (Object.keys(pushed.byKey).some((key) => !wanted.has(key))) pushed.byKey = Object.fromEntries(Object.entries(pushed.byKey).filter(([key]) => wanted.has(key)));
            if (!channel || !Machine) return;
            for (const key of wanted.keys()) {
                if (subs.has(key)) continue;
                const [, type] = (actorKey as (d: AnyActorDefinition, key: string, method: string) => readonly unknown[])(Machine as AnyActorDefinition, key, 'get') as [string, string];
                subs.set(
                    key,
                    channel.subscribe({ type, key, method: 'get', args: [] }, (value: unknown) => {
                        if (value && subs.has(key)) pushed.byKey = { ...pushed.byKey, [key]: value as MachineView };
                    })
                );
            }
        });
    });
    ctx.onDeactivated(() => {
        runner.stop();
        for (const off of subs.values()) off();
        subs.clear();
    });

    /** Machine id → its record: the last pushed frame, else the fetched one; paired machines only. */
    const views = computed((): Record<string, MachineView> => {
        const w = ws();
        const out: Record<string, MachineView> = {};
        if (!w) return out;
        const got = fetched.value ?? {};
        for (const m of paired.value) {
            const v = pushed.byKey[machineKeyOf(w, m.id)] ?? got[m.id];
            if (v) out[m.id] = v;
        }
        return out;
    });
    const directory = computed(() => foldEnvironments(paired.value.map((m) => m.id), views.value));

    return {
        /** The paired machines of the workspace index, index order. */
        paired,
        /** Machine id → its live `Machine.get` (revoked ones too); a machine is absent until its record arrives. */
        views,
        /** Every environment of every paired, unrevoked machine, machine order. */
        environments: computed(() => directory.value.entries),
        /** Every paired, unrevoked machine with what it reports, index order. */
        machines: computed(() => directory.value.machines),
        /** The index or the records are still loading. */
        loading: computed(() => workspace.machinesRead.loading || fetched.loading),
        /** One machine's record (`undefined` until it arrives). */
        machine: (id: string): MachineView | undefined => views.value[id],
        /** The accounts the machines report (#414, `accountDirectory`). */
        accounts: (): AccountEntry[] => accountDirectory(directory.value.machines.map((m) => ({ machineId: m.id as never, environments: m.environments }))),
        /** The environment of `ref` on `machineId` for `runtime` — the one the router would take (#414). */
        accountEnvironment: (machineId: string, runtime: RuntimeId, ref: AccountRef): EnvironmentEntry | undefined => {
            const m = directory.value.machines.find((x) => x.id === machineId);
            const env = m ? environmentsForAccount(m.environments, runtime, ref)[0] : undefined;
            return env ? directory.value.entries.find((e) => e.machineId === machineId && e.id === env.id) : undefined;
        }
    };
});
