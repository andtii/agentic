/**
 * `/machines` on the platform (#144): the Workspace's machine index read
 * live, each paired machine's record a live read of its own
 * (`Machine.get`: online, last seen, the environments the daemon reported
 * with their auth status), the router's parked tasks as the queued counts
 * (EXE-12), the directory's agents on the "Default for" tiles — rendered
 * as the same machine groups the mock page draws. Each environment card
 * carries its account's provider limits from `MachineView.quota` (#270).
 *
 * Daemon updates (#367): each group also reads its machine's
 * `updateState()` live for the update pill, and hands it up so "Update all
 * machines" knows which ones have a release waiting; it asks each of them
 * with `requestUpdate({ mode: 'drain' })` and lists what they answered.
 * A second pill counts the runtimes with a newer harness waiting (#370),
 * from the same `get`.
 */
import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { MachineUpdateView } from '@agentic/platform';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, routingKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { LIVE_PLATFORM_ROW, defaultForByEnvironment, machineLoadOf, machineOf, platformAgents, queuedByEnvironment } from './live';
import type { AgentIdentity } from '../chat/live';
import { MachineGroup, PlatformRow } from './MachineGroup';
import { UpdateAll, type UpdateAllEntry, type UpdateAllResult } from './UpdateAll';
import { harnessUpdates } from './harness';
import { needsReinstall, updateBadge } from './update';

/** One machine's group over a live read of its record; busy (and empty) until the first value. */
const LiveMachineGroup = component<{ id: string; name: string; workspaceId: string; queued: Readonly<Record<string, number>>; agents: readonly AgentIdentity[]; report: (id: string, update: MachineUpdateView | null) => void }>(({ props }) => {
    const defs = useActorDefs();
    const view = useActorState(defs.Machine, () => [machineKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const update = useActorState(defs.Machine, () => [machineKeyOf(props.workspaceId, props.id), 'updateState'] as const, { live: true });
    const stopReport = effect(() => { props.report(props.id, update.value ?? null); });
    onUnmounted(() => { stopReport(); props.report(props.id, null); });
    return (): JSXElement => {
        const v = view.value;
        if (!v) return <section data-machine-group data-machine={props.id} aria-label={props.name} aria-busy="true" />;
        // "Default for" per environment (#414): pinned agents by id, account-bound ones by the login this machine reports.
        return <MachineGroup machine={machineOf(v, props.name, Date.now())} environments={v.environments} queued={props.queued} defaultFor={defaultForByEnvironment(props.agents, v.environments)} quota={v.quota ?? {}} {...(v.telemetry ? { load: v.telemetry.environments, machineLoad: machineLoadOf(v.telemetry, Date.now()) } : {})} update={v.revoked ? null : updateBadge(update.value)} harnessUpdates={v.revoked ? 0 : harnessUpdates(v)} />;
    };
});

export const LiveMachines = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const index = useActorState(defs.Workspace, () => { const ws = viewer.workspaceId; return ws && ([workspaceKeyOf(ws), 'listMachines'] as const); }, { live: true });
    const routing = useActorState(defs.Routing, () => { const ws = viewer.workspaceId; return ws && ([routingKeyOf(ws), 'get'] as const); }, { live: true });
    const st = signal({ updates: {} as Record<string, MachineUpdateView>, results: null as UpdateAllResult[] | null, busy: false });
    const report = (id: string, update: MachineUpdateView | null): void => {
        if ((st.updates[id] ?? null) === update) return;
        const next = { ...st.updates };
        if (update) next[id] = update;
        else delete next[id];
        st.updates = next;
    };
    const updateAll = async (targets: readonly UpdateAllEntry[]): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.busy) return;
        st.busy = true;
        st.results = await Promise.all(targets.map(async (t): Promise<UpdateAllResult> => {
            try {
                await actor(defs.Machine, machineKeyOf(ws, t.id)).requestUpdate({ mode: 'drain' });
                return { id: t.id, name: t.name, ok: true, text: `asked to update to ${t.update?.available?.version ?? 'the new release'} when idle` };
            } catch (e) {
                return { id: t.id, name: t.name, ok: false, text: needsReinstall(e) ? 'cannot update itself: reinstall once from its page' : e instanceof Error ? e.message : String(e) };
            }
        }));
        st.busy = false;
    };
    return (): JSXElement => {
        const ws = viewer.workspaceId;
        const signedOut = !viewer.pending && !ws;
        const paired = (index.value ?? []).filter((m) => m.status === 'paired');
        const agents = directory.all();
        return (
            <OpsPage page="machines" title="Machines">
                {ws ? <UpdateAll machines={paired.map((m) => ({ id: m.id, name: m.name, update: st.updates[m.id] ?? null }))} results={st.results} busy={st.busy} onRun={(targets: readonly UpdateAllEntry[]) => { void updateAll(targets); }} /> : null}
                {ws ? paired.map((m) => <LiveMachineGroup id={m.id} name={m.name} workspaceId={ws} queued={queuedByEnvironment(routing.value ?? undefined, m.id)} agents={agents} report={report} />) : null}
                <PlatformRow defaultFor={platformAgents(agents)} caption={LIVE_PLATFORM_ROW.caption} keyStatus={LIVE_PLATFORM_ROW.key} keyLabel={LIVE_PLATFORM_ROW.keyLabel} />
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your machines" caption="Machines belong to your workspace." />
                    : paired.length === 0 && !index.loading
                        ? <EmptyState variant="machines" />
                        : null}
            </OpsPage>
        );
    };
});
