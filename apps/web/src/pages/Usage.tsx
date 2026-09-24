import { component, signal, type Define } from 'sigx';
import { Card } from '@sigx/zero';
import { AgentTile, DataTable, Label, Segmented, StatusPill } from '@agentic/ui';
import { dataMode } from '../data-mode';
import { money, opsAgent, opsLimitAccounts, tokensText, usageDays, usageRows, usageStats, type UsageBy, type UsageRow } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';
import { USAGE_COLS } from './usage/live';
import { LiveUsage } from './usage/LiveUsage';
import { LimitsSection } from './usage/Limits';
import { UsageStats } from './usage/UsageStats';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables). */
export { USAGE_COLS };

const BY_LABEL: Record<UsageBy, string> = { agent: 'Agent', task: 'Task', turn: 'Turn' };

export type UsageViewProps =
    & Define.Prop<'rows', Readonly<Record<UsageBy, readonly UsageRow[]>>, true>
    & Define.Prop<'by', UsageBy>;

/**
 * `/usage` — segmented by agent, task or turn; four stat cards; cost per
 * day; the table with its mandatory data-quality column. An unreported
 * figure prints `n/a` in text-dim, never 0 or blank; an estimate is
 * prefixed `~` and carries `PARTLY ESTIMATED` (OPS-07). Above them, each
 * account's provider limits (#270). `Ledger.summary` replaces the mock with #45.
 */
export const UsageView = component<UsageViewProps>(({ props }) => {
    const ui = signal<{ by: UsageBy }>({ by: props.by ?? 'agent' });
    const max = Math.max(...usageDays.values);
    return () => (
        <OpsPage
            page="usage"
            title="Usage"
            slots={{
                lead: () => (
                    <Segmented
                        label="Group usage by"
                        model={() => ui.by}
                        options={[{ value: 'agent', label: 'By agent' }, { value: 'task', label: 'By task' }, { value: 'turn', label: 'By turn' }]}
                        onValueChange={(v: string) => { ui.by = v as UsageBy; }}
                    />
                )
            }}
        >
            <LimitsSection accounts={opsLimitAccounts()} />

            <UsageStats stats={usageStats} />

            <Card.Root asChild data-usage-days="" aria-label="Cost per day">
                {(part: Record<string, unknown>) => (
                    <section {...part}>
                        <Card.Body data-card-body="">
                            <div data-label-row>
                                <Label>Cost per day · USD · anthropic-api</Label>
                                <span data-label-aside>{usageDays.from} to {usageDays.to}</span>
                            </div>
                            <div data-bars role="img" aria-label={`Cost per day from ${usageDays.from} to ${usageDays.to}; today ${usageDays.today}`}>
                                {usageDays.values.map((v, i) => <span data-bar data-today={i === usageDays.values.length - 1 ? '' : undefined} style={`--h: ${Math.round((v / max) * 100)}%`} />)}
                            </div>
                            <div data-bars-foot>
                                <span>1</span>
                                <span data-bars-today>today <strong>{usageDays.today}</strong></span>
                            </div>
                        </Card.Body>
                    </section>
                )}
            </Card.Root>

            <DataTable
                cols={USAGE_COLS}
                label={`Usage by ${ui.by}`}
                columns={[{ label: BY_LABEL[ui.by] }, { label: 'Tasks' }, { label: 'Tokens' }, { label: 'Cost' }, { label: 'Data quality' }]}
                class="ag-usage"
            >
                {props.rows[ui.by].map(row => {
                    const agent = row.agentId ? opsAgent(row.agentId) : undefined;
                    return (
                        <DataTable.Row data-usage-row={row.id} data-quality={row.quality}>
                            <DataTable.Cell column={0}>
                                <span data-agent-cell>
                                    {agent ? <AgentTile name={agent.name} hue={agent.hue} size={22} /> : null}
                                    <span data-ellipsis title={row.label}>{row.label}</span>
                                    <span data-usage-sub>{agent ? agent.runtime : row.sub}</span>
                                </span>
                            </DataTable.Cell>
                            <DataTable.Cell column={1}><code data-mono>{row.tasks}</code></DataTable.Cell>
                            <DataTable.Cell column={2}><code data-mono data-dim={row.tokens === null ? '' : undefined}>{tokensText(row.tokens)}</code></DataTable.Cell>
                            <DataTable.Cell column={3}><code data-mono data-cost={row.quality}>{money(row.costUsd, row.quality)}</code></DataTable.Cell>
                            <DataTable.Cell column={4}><StatusPill status={row.quality} hollow /></DataTable.Cell>
                        </DataTable.Row>
                    );
                })}
            </DataTable>
        </OpsPage>
    );
});

/** `/usage` — the mock rows, or the month's Ledger in live mode (#146). */
export const Usage = component(() => () => (dataMode() === 'live' ? <LiveUsage /> : <UsageView rows={usageRows} />));
