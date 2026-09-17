import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Card } from '@sigx/zero-daisyui/components';
import { EnvironmentLine, Label, SectionHeading, Stack, StatusPill } from '@agentic/ui';
import type { MockAgent } from '../../mock/data';
import { sessionRows, type AgentProfile } from '../../mock/agents';
import { age } from './format';

export type OverviewTabProps = Define.Prop<'profile', AgentProfile, true> & Define.Prop<'agent', MockAgent, true>;

/** Overview: description, environment, stats, the last sessions. Minimal by design (the handoff draws no board for it). */
export const OverviewTab = component<OverviewTabProps>(({ props }) => () => {
    const p = props.profile;
    const recent = sessionRows(p.id).slice(0, 5);
    return (
        <div data-agent-overview="">
            <Stack gap="lg">
                <p data-agent-overview-description="">{p.config.description}</p>
                <Stack gap="xs">
                    <Label>Default environment</Label>
                    {p.environment
                        ? <EnvironmentLine machine={p.environment.machine} runtime={p.environment.runtime} account={p.environment.account} tone="live" />
                        : <span data-tone="needs-you">No environment</span>}
                </Stack>
                <dl data-agent-stats="">
                    <div><dd>v{props.agent.configVersion}</dd><dt>config</dt></div>
                    <div><dd>{p.memories.length}</dd><dt>memories</dt></div>
                    <div><dd>{p.correctionsThisWeek}</dd><dt>corrections / wk</dt></div>
                    <div><dd>{recent.length}</dd><dt>sessions</dt></div>
                </dl>
            </Stack>
            <div data-agent-recent="">
            <Card>
                <Card.Body>
                    <SectionHeading level={3}>Recent sessions</SectionHeading>
                    {recent.length ? (
                        <ul data-agent-recent-list="">
                            {recent.map((s) => (
                                <li>
                                    <Link to={`/sessions/${s.id}`}>{s.id}</Link>
                                    <StatusPill status={s.status} />
                                    <span data-tone="dim">{age(s.startedAt)}</span>
                                </li>
                            ))}
                        </ul>
                    ) : <p data-tone="muted">No sessions yet.</p>}
                </Card.Body>
            </Card>
            </div>
        </div>
    );
}, { name: 'OverviewTab' });
