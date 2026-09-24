/**
 * The four stat cards on `/usage` (OPS-07): each is zero's `Stats` with one
 * item — the label, the figure, the caption — in a grid that wraps to two
 * columns and then one. A card's tone colours its figure through the Stats
 * `color` axis (needs-you → warning); a muted figure is the muted ink.
 * `data-stat` / `data-tone` stay on each card's root for tests.
 */
import { component, type Define } from 'sigx';
import { Stats } from '@sigx/zero';
import { Label, type Tone } from '@agentic/ui';

export interface StatCard {
    readonly label: string;
    readonly value: string;
    readonly caption: string;
    readonly tone?: Tone;
}

/** Only an amber figure takes a role; live is the plain ink, muted the muted one (`usage.css`). */
const colorOf = (tone: Tone | undefined): 'warning' | undefined => (tone === 'needs-you' ? 'warning' : undefined);

export type UsageStatsProps =
    & Define.Prop<'stats', readonly StatCard[], true>
    & Define.Prop<'busy', boolean>;

export const UsageStats = component<UsageStatsProps>(({ props }) => () => (
    <div data-usage-stats aria-busy={props.busy ? 'true' : undefined}>
        {props.stats.map((stat) => (
            <Stats.Root color={colorOf(stat.tone)} role="group" aria-label={stat.label} data-stat="" data-tone={stat.tone}>
                <Stats.Item>
                    <Stats.Title><Label>{stat.label}</Label></Stats.Title>
                    <Stats.Value data-stat-value="">{stat.value}</Stats.Value>
                    <Stats.Desc data-stat-caption="">{stat.caption}</Stats.Desc>
                </Stats.Item>
            </Stats.Root>
        ))}
    </div>
), { name: 'UsageStats' });
