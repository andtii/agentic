/**
 * `/usage` on the platform (#146, OPS-07): the current UTC month's Ledger
 * (`{ws}:ledger:{yyyy-mm}`) summarised by agent, task or day —
 * `Ledger.summary({ by })` — with the four stat cards, the cost-per-day
 * bars (`summary({ by: 'day', timeZone })`) and the table with its
 * mandatory data-quality column, in the mock page's anatomy. The reported
 * and the estimated part of a cost are printed as two figures
 * (`$1.20 + ~$0.30`), a group nothing priced as `n/a` in the dim ink.
 *
 * `summary` takes an options object, which the live read's canonical key
 * cannot carry, so the page reads through `useData` and re-reads on the
 * grouping, the month and the Refresh action; Home's spend panel reads the
 * same total through `useMonthSpend`. Above the stats, every account's
 * provider limits from the machines (`LiveLimits`, #270).
 */
import { component, onMounted, signal, useData, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { Card } from '@sigx/zero';
import { useActorState } from '@sigx/actors/app';
import type { LedgerSummary } from '@agentic/platform';
import { AgentTile, Button, DataTable, ErrorNote, Label, Segmented, StatusPill } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../actors/defs';
import { ledgerKeyOf, ledgerMonthOf, workspaceKeyOf } from '../../actors/keys';
import { OpsPage } from '../ops/OpsPage';
import { LiveLimits } from './Limits';
import { UsageStats } from './UsageStats';
import { useAgentDirectory } from '../chat/directory';
import { costText, dayOf, daysOf, statsOf, tokensText, USAGE_BY, USAGE_COLS, usageRowsOf, type LiveUsageBy } from './live';

export interface MonthSpend {
    readonly month: string;
    readonly summary: LedgerSummary | null;
    readonly loading: boolean;
    readonly error: Error | null;
    refresh(): Promise<void>;
}

/** Called in setup: the month's totals grouped `by`, re-read when the key changes or on `refresh()`. */
export function useMonthSummary(defs: ActorDefs, viewer: ViewerState, by: () => LiveUsageBy | 'day', month: () => string, timeZone: () => string | undefined): MonthSpend {
    const data = useData(
        () => {
            const ws = viewer.workspaceId;
            return ws ? (['ledger', ws, month(), by(), timeZone() ?? 'UTC'] as const) : false;
        },
        async (key): Promise<LedgerSummary> => {
            const [, ws, m, b, tz] = key;
            return actor(defs.Ledger, ledgerKeyOf(ws, m)).summary({ by: b, timeZone: tz });
        }
    );
    // The page cache restores a key's last value on every mount without a fetch; a summary is a total that moves, so a mount re-reads it.
    onMounted(() => {
        if (data.hasValue) void data.refresh();
    });
    return {
        get month() {
            return month();
        },
        get summary() {
            return data.value ?? null;
        },
        get loading() {
            return data.loading;
        },
        get error() {
            return data.error;
        },
        refresh: () => data.refresh()
    };
}

/** Home's spend panel: this month's total by agent. */
export function useMonthSpend(defs: ActorDefs, viewer: ViewerState): MonthSpend {
    return useMonthSummary(defs, viewer, () => 'agent', () => ledgerMonthOf(Date.now()), () => undefined);
}

export const LiveUsage = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const ws = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const timeZone = (): string | undefined => ws.value?.settings.timeZone;
    const ui = signal<{ by: LiveUsageBy; month: string }>({ by: 'agent', month: ledgerMonthOf(Date.now()) });
    const grouped = useMonthSummary(defs, viewer, () => ui.by, () => ui.month, timeZone);
    const byDay = useMonthSummary(defs, viewer, () => 'day', () => ui.month, timeZone);
    const refresh = (): void => {
        void grouped.refresh();
        void byDay.refresh();
    };
    return (): JSXElement => {
        const rows = usageRowsOf(grouped.summary, ui.by, directory.lookup);
        const stats = statsOf(grouped.summary?.total ?? null, ui.month);
        const days = daysOf(byDay.summary, ui.month, dayOf(Date.now(), timeZone()));
        const max = Math.max(0, ...days.values);
        const column = USAGE_BY.find((b) => b.value === ui.by)!.column;
        return (
            <OpsPage
                page="usage"
                title="Usage"
                slots={{
                    lead: () => (
                        <Segmented
                            label="Group usage by"
                            model={() => ui.by}
                            options={USAGE_BY.map((b) => ({ value: b.value, label: b.label }))}
                            onValueChange={(v: string) => { ui.by = v as LiveUsageBy; }}
                        />
                    ),
                    actions: () => <Button intent="default" onClick={refresh} disabled={grouped.loading}>Refresh</Button>
                }}
            >
                <LiveLimits />

                <UsageStats stats={stats} busy={grouped.loading} />

                <Card.Root asChild data-usage-days="" aria-label="Cost per day">
                    {(part: Record<string, unknown>) => (
                        <section {...part}>
                            <Card.Body data-card-body="">
                                <div data-label-row>
                                    <Label>Cost per day · USD · reported + estimated</Label>
                                    <span data-label-aside>{days.from} to {days.to}</span>
                                </div>
                                <div data-bars role="img" aria-label={`Cost per day from ${days.from} to ${days.to}; today ${days.today}`}>
                                    {days.values.map((v, i) => <span data-bar data-today={i === days.values.length - 1 ? '' : undefined} style={`--h: ${max > 0 ? Math.round((v / max) * 100) : 0}%`} />)}
                                </div>
                                <div data-bars-foot>
                                    <span>1</span>
                                    <span data-bars-today>today <strong>{days.today}</strong></span>
                                </div>
                            </Card.Body>
                        </section>
                    )}
                </Card.Root>

                <DataTable
                    cols={USAGE_COLS}
                    label={`Usage by ${ui.by}`}
                    columns={[{ label: column }, { label: 'Turns' }, { label: 'Tokens' }, { label: 'Cost' }, { label: 'Data quality' }]}
                    class="ag-usage"
                >
                    {rows.map((row) => (
                        <DataTable.Row data-usage-row={row.id} data-quality={row.quality}>
                            <DataTable.Cell>
                                <span data-agent-cell>
                                    {row.agent ? <AgentTile name={row.agent.name} hue={row.agent.hue} size={22} /> : null}
                                    <span data-ellipsis title={row.label}>{row.label}</span>
                                    <span data-usage-sub>{row.sub}</span>
                                </span>
                            </DataTable.Cell>
                            <DataTable.Cell><code data-mono>{row.turns}</code></DataTable.Cell>
                            <DataTable.Cell><code data-mono data-dim={row.tokens === null ? '' : undefined}>{tokensText(row.tokens)}</code></DataTable.Cell>
                            <DataTable.Cell><code data-mono data-cost={row.quality} data-dim={row.cost === null ? '' : undefined}>{costText(row.cost)}</code></DataTable.Cell>
                            <DataTable.Cell><StatusPill status={row.quality} hollow {...(row.quality === 'estimated' ? { tone: 'needs-you' as const, label: 'ESTIMATED' } : {})} /></DataTable.Cell>
                        </DataTable.Row>
                    ))}
                </DataTable>
                {!rows.length && !grouped.loading ? <p data-panel-note data-usage-empty>No usage recorded in {ui.month}. Each turn a session runs adds a row.</p> : null}
                {grouped.error ? <ErrorNote data-chat-error="">{grouped.error.message}</ErrorNote> : null}
            </OpsPage>
        );
    };
});
