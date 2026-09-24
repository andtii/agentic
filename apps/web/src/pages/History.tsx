import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, DataTable, FilterChips, Tag, type Tone } from '@agentic/ui';
import { dataMode } from '../data-mode';
import { historyFilters, opsAgent, opsHistory, type HistoryEntry, type HistoryFilter, type HistoryKind } from '../mock/ops';
import { clock, groupByDay } from './ops/format';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';
import { HISTORY_COLS } from './history/live';
import { LiveHistory } from './history/LiveHistory';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables). */
export { HISTORY_COLS };

/** A kind's tag tone: what waits on a person is amber, what broke is red, what was learned is live, the rest is neutral. */
export const KIND_TONE: Partial<Record<HistoryKind, Tone>> = { 'approval-asked': 'needs-you', interrupted: 'failed', correction: 'live' };

export function kindLabel(kind: HistoryKind): string {
    return kind.replace('-', ' ');
}

/** The entries a filter shows, newest first. */
export function filterHistory(entries: readonly HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
    const spec = historyFilters.find(f => f.id === filter);
    const kinds = spec?.kinds;
    const kept = kinds ? entries.filter(e => (kinds as readonly HistoryKind[]).includes(e.kind)) : [...entries];
    return kept.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export type HistoryViewProps = Define.Prop<'entries', readonly HistoryEntry[], true> & Define.Prop<'filter', HistoryFilter>;

/**
 * `/history` — filter chips by kind (`aria-pressed`), then time, kind
 * tag, actor, what happened and the ref link, newest first and grouped by
 * day (OPS-03). `Audit.list(filter)` replaces the mock with #44.
 */
defineTopbar('history', () => ({ actions: () => <Button intent="default" icon="download">Export</Button> }));

export const HistoryView = component<HistoryViewProps>(({ props }) => {
    const ui = signal<{ filter: HistoryFilter }>({ filter: props.filter ?? 'all' });
    return () => {
        const groups = groupByDay(filterHistory(props.entries, ui.filter));
        return (
            <OpsPage
                page="history"
                title="History"
                slots={{
                    lead: () => (
                        <FilterChips
                            label="Filter by kind"
                            model={() => ui.filter}
                            options={historyFilters.map(f => ({ value: f.id, label: f.label }))}
                            onValueChange={(v: string) => { ui.filter = v as HistoryFilter; }}
                        />
                    )
                }}
            >
                <DataTable
                    cols={HISTORY_COLS}
                    label="History"
                    columns={[{ label: 'Time' }, { label: 'Kind' }, { label: 'Actor' }, { label: 'What happened' }, { label: 'Ref' }]}
                    class="ag-history"
                >
                    {groups.map(group => [
                        // A day heading spans the row.
                        <DataTable.Row data-day-row={group.day}>
                            <DataTable.Cell colSpan={5}><span data-day-label>{group.label}</span></DataTable.Cell>
                        </DataTable.Row>,
                        ...group.items.map(e => {
                            const agent = e.actor === 'you' ? undefined : opsAgent(e.actor);
                            return (
                                <DataTable.Row data-history-row={e.id} data-kind={e.kind}>
                                    <DataTable.Cell><code data-mono data-dim>{clock(e.at)}</code></DataTable.Cell>
                                    <DataTable.Cell><Tag tone={KIND_TONE[e.kind]}>{kindLabel(e.kind)}</Tag></DataTable.Cell>
                                    <DataTable.Cell>
                                        <span data-agent-cell>
                                            {agent ? <AgentTile name={agent.name} hue={agent.hue} size={22} /> : <AgentTile name="Andii" person size={22} />}
                                            <span>{agent ? agent.name : 'You'}</span>
                                        </span>
                                    </DataTable.Cell>
                                    <DataTable.Cell><span data-ellipsis title={e.what}>{e.what}</span></DataTable.Cell>
                                    <DataTable.Cell><Link to={e.ref.href} class="ag-ref">{e.ref.label}</Link></DataTable.Cell>
                                </DataTable.Row>
                            );
                        })
                    ])}
                </DataTable>
            </OpsPage>
        );
    };
});

/** `/history` — the mock entries, or the Audit actor in live mode (#146). */
export const History = component(() => () => (dataMode() === 'live' ? <LiveHistory /> : <HistoryView entries={opsHistory} />));
