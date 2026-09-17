import { component, signal, type Define } from 'sigx';
import { AgentTile, DataTable, Label, Segmented, StatusPill } from '@agentic/ui';
import { money, opsAgent, tokensText, usageDays, usageRows, usageStats, type UsageBy, type UsageRow } from '../mock/ops';
import { OpsPage } from './ops/OpsPage';

/** The artboard's column template (`docs/design/HANDOFF.md` → tables). */
export const USAGE_COLS = '1fr 120px 120px 130px 150px';

const BY_LABEL: Record<UsageBy, string> = { agent: 'Agent', task: 'Task', turn: 'Turn' };

export type UsageViewProps =
    & Define.Prop<'rows', Readonly<Record<UsageBy, readonly UsageRow[]>>, true>
    & Define.Prop<'by', UsageBy>;

/**
 * `/usage` — segmented by agent, task or turn; four stat cards; cost per
 * day; the table with its mandatory data-quality column. An unreported
 * figure prints `n/a` in text-dim, never 0 or blank; an estimate is
 * prefixed `~` and carries `PARTLY ESTIMATED` (OPS-07). `Ledger.summary`
 * replaces the mock with #45.
 */
export const UsageView = component<UsageViewProps>(({ props }) => {
    const ui = signal<{ by: UsageBy }>({ by: props.by ?? 'agent' });
    const max = Math.max(...usageDays.values);
    return () => (
        <OpsPage
            page="usage"
            title="Usage"
            slots={{
                actions: () => (
                    <Segmented
                        label="Group usage by"
                        model={() => ui.by}
                        options={[{ value: 'agent', label: 'By agent' }, { value: 'task', label: 'By task' }, { value: 'turn', label: 'By turn' }]}
                        onValueChange={(v: string) => { ui.by = v as UsageBy; }}
                    />
                )
            }}
        >
            <div data-usage-stats>
                {usageStats.map(stat => (
                    <section data-card data-stat data-tone={stat.tone} aria-label={stat.label}>
                        <Label>{stat.label}</Label>
                        <span data-stat-value>{stat.value}</span>
                        <span data-stat-caption>{stat.caption}</span>
                    </section>
                ))}
            </div>

            <section data-card data-usage-days aria-label="Cost per day">
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
            </section>

            <DataTable
                cols={USAGE_COLS}
                label={`Usage by ${ui.by}`}
                columns={[{ label: BY_LABEL[ui.by] }, { label: 'Tasks' }, { label: 'Tokens' }, { label: 'Cost' }, { label: 'Data quality' }]}
                class="ag-usage"
            >
                {props.rows[ui.by].map(row => {
                    const agent = row.agentId ? opsAgent(row.agentId) : undefined;
                    return (
                        <tr data-scope="table" data-part="row" data-usage-row={row.id} data-quality={row.quality}>
                            <DataTable.Cell>
                                <span data-agent-cell>
                                    {agent ? <AgentTile name={agent.name} hue={agent.hue} size={22} /> : null}
                                    <span data-ellipsis title={row.label}>{row.label}</span>
                                    <span data-usage-sub>{agent ? agent.runtime : row.sub}</span>
                                </span>
                            </DataTable.Cell>
                            <DataTable.Cell><code data-mono>{row.tasks}</code></DataTable.Cell>
                            <DataTable.Cell><code data-mono data-dim={row.tokens === null ? '' : undefined}>{tokensText(row.tokens)}</code></DataTable.Cell>
                            <DataTable.Cell><code data-mono data-cost={row.quality}>{money(row.costUsd, row.quality)}</code></DataTable.Cell>
                            <DataTable.Cell><StatusPill status={row.quality} hollow /></DataTable.Cell>
                        </tr>
                    );
                })}
            </DataTable>
        </OpsPage>
    );
});

export const Usage = component(() => () => <UsageView rows={usageRows} />);
