/**
 * `/history` on the platform (#146, OPS-03): the workspace's Audit log —
 * `Audit.list(query)` newest first, filtered by kind (chips), agent (a
 * select over the directory) and time window (chips), paged by the
 * actor's `seq` cursor ("Load older") — grouped by day in the mock page's
 * anatomy. `list` takes a query object, which a live read's canonical key
 * cannot carry, so the page subscribes to the cheap `stats()` read
 * (`{ live: true }`: `recorded` moves on every event) and re-reads the
 * first page through `useData` whenever it does; older pages are fetched
 * once each and merged by event key.
 */
import { component, onMounted, signal, useData, watch, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AuditEvent, AuditPage } from '@agentic/platform';
import { AgentTile, Button, DataTable, EmptyState, ErrorNote, FilterChips, SelectField, Tag } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { auditKeyOf, workspaceKeyOf } from '../../actors/keys';
import { clock, groupByDay } from '../ops/format';
import { OpsPage } from '../ops/OpsPage';
import { useAgentDirectory } from '../chat/directory';
import { auditQueryOf, DEFAULT_FILTERS, HISTORY_COLS, HISTORY_KIND_FILTERS, HISTORY_WINDOWS, mergePages, rowOf, type HistoryFilters, type HistoryKindFilter, type HistoryWindow } from './live';

/** The agent filter's "no agent" item. */
const EVERY_ACTOR = '*';

export const LiveHistory = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const ws = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const stats = useActorState(defs.Audit, () => viewer.workspaceId && ([auditKeyOf(viewer.workspaceId), 'stats'] as const), { live: true });
    const ui = signal<{ filters: HistoryFilters }>({ filters: DEFAULT_FILTERS });
    const older = signal<{ pages: AuditEvent[][]; next: number | null; loading: boolean; error: string }>({ pages: [], next: null, loading: false, error: '' });

    const filterKey = (): string => `${ui.filters.kind}|${ui.filters.agentId ?? ''}|${ui.filters.window}`;
    const first = useData(
        () => {
            const w = viewer.workspaceId;
            return w ? (['audit', w, filterKey(), stats.value?.recorded ?? -1] as const) : false;
        },
        async (key): Promise<AuditPage> => actor(defs.Audit, auditKeyOf(key[1])).list(auditQueryOf(ui.filters, Date.now()))
    );
    // The page cache restores `stats` on a remount without a fetch; re-reading it moves `recorded` and with it the first page's key.
    onMounted(() => {
        if (stats.hasValue) void stats.refresh();
    });
    // A filter change starts the paging over; the first page re-reads by its key.
    watch(filterKey, () => {
        older.pages = [];
        older.next = null;
        older.error = '';
    });

    const set = (patch: Partial<HistoryFilters>): void => {
        ui.filters = { ...ui.filters, ...patch };
    };
    // The agent Select binds a string; "Every actor" is an item of its own (a `''` option would be the placeholder, never chosen again).
    const pick = signal({ agent: ui.filters.agentId ?? EVERY_ACTOR });
    watch(() => pick.agent, (id) => set({ agentId: id && id !== EVERY_ACTOR ? id : null }));
    const nextCursor = (): number | null => (older.pages.length ? older.next : (first.value?.next ?? null));
    const loadOlder = async (): Promise<void> => {
        const w = viewer.workspaceId;
        const cursor = nextCursor();
        if (!w || cursor === null || older.loading) return;
        older.loading = true;
        older.error = '';
        try {
            const page = await actor(defs.Audit, auditKeyOf(w)).list(auditQueryOf(ui.filters, Date.now(), cursor));
            older.pages = [...older.pages, [...page.events]];
            older.next = page.next;
        } catch (e) {
            older.error = e instanceof Error ? e.message : String(e);
        } finally {
            older.loading = false;
        }
    };

    return (): JSXElement => {
        const timeZone = ws.value?.settings.timeZone;
        const events = mergePages([first.value?.events ?? [], ...older.pages]);
        const rows = events.map((e) => rowOf(e, directory.lookup, timeZone));
        const groups = groupByDay(rows);
        const signedOut = !viewer.pending && !viewer.workspaceId;
        const more = nextCursor() !== null;
        return (
            <OpsPage
                page="history"
                title="History"
                slots={{
                    lead: () => (
                        <div data-history-filters>
                            <FilterChips
                                label="Filter by kind"
                                model={() => ui.filters.kind}
                                options={HISTORY_KIND_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
                                onValueChange={(v: string) => set({ kind: v as HistoryKindFilter })}
                            />
                            <div data-history-window>
                                <FilterChips
                                    label="Filter by time"
                                    model={() => ui.filters.window}
                                    options={HISTORY_WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
                                    onValueChange={(v: string) => set({ window: v as HistoryWindow })}
                                />
                            </div>
                            <div data-history-agent>
                                <SelectField
                                    name="history-agent"
                                    label="Agent"
                                    model={() => pick.agent}
                                    options={[{ value: EVERY_ACTOR, label: 'Every actor' }, ...directory.all().map((a) => ({ value: a.id, label: a.name }))]}
                                />
                            </div>
                        </div>
                    )
                }}
            >
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your history" caption="The audit log belongs to your workspace." />
                    : (
                        <DataTable
                            cols={HISTORY_COLS}
                            label="History"
                            columns={[{ label: 'Time' }, { label: 'Kind' }, { label: 'Actor' }, { label: 'What happened' }, { label: 'Ref' }]}
                            class="ag-history"
                        >
                            {groups.map((group) => [
                                // A day heading spans the row.
                                <DataTable.Row data-day-row={group.day}>
                                    <DataTable.Cell colSpan={5}><span data-day-label>{group.label}</span></DataTable.Cell>
                                </DataTable.Row>,
                                ...group.items.map((e) => (
                                    <DataTable.Row data-history-row={e.id} data-kind={e.kind} data-seq={String(e.seq)}>
                                        <DataTable.Cell><code data-mono data-dim>{clock(e.at)}</code></DataTable.Cell>
                                        <DataTable.Cell><Tag tone={e.tone}>{e.label}</Tag></DataTable.Cell>
                                        <DataTable.Cell>
                                            <span data-agent-cell>
                                                <AgentTile name={e.actor.name} hue={e.actor.hue} person={e.actor.person} size={22} />
                                                <span>{e.actor.name}</span>
                                            </span>
                                        </DataTable.Cell>
                                        <DataTable.Cell><span data-ellipsis title={e.what}>{e.what}</span></DataTable.Cell>
                                        <DataTable.Cell>{e.ref ? <Link to={e.ref.href} class="ag-ref">{e.ref.label}</Link> : <span data-dim>—</span>}</DataTable.Cell>
                                    </DataTable.Row>
                                ))
                            ])}
                        </DataTable>
                    )}
                {!signedOut && !rows.length && !first.loading ? <p data-panel-note data-history-empty>Nothing recorded {ui.filters.kind === 'all' && ui.filters.window === 'all' && !ui.filters.agentId ? 'yet' : 'for these filters'}. Every approval, delegation, environment choice, transition and config change lands here.</p> : null}
                {first.loading && !rows.length ? <p data-panel-note aria-busy="true">Loading history…</p> : null}
                {more || older.loading
                    ? (
                        <p data-history-more>
                            <Button intent="default" disabled={older.loading || !more} onClick={() => { void loadOlder(); }}>{older.loading ? 'Loading…' : 'Load older'}</Button>
                        </p>
                    )
                    : null}
                {older.error || first.error ? <ErrorNote data-chat-error="">{older.error || first.error?.message}</ErrorNote> : null}
            </OpsPage>
        );
    };
});
