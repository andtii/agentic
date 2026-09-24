import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Card } from '@sigx/zero-daisyui/components';
import { EnvironmentLine, Label, SectionHeading, StatusPill } from '@agentic/ui';
import { Col } from '@sigx/zero';
import type { MockAgent } from '../../mock/data';
import { sessionRows, type AgentProfile, type SessionRow } from '../../mock/agents';
import { age } from './format';

export type OverviewTabProps =
    & Define.Prop<'profile', AgentProfile, true>
    & Define.Prop<'agent', MockAgent, true>
    /** The agent's sessions on the platform (`sessionRowsOf`, #153); absent, the mock workspace's. */
    & Define.Prop<'sessions', readonly SessionRow[]>
    /** The workspace's IANA zone; absent, the mock workspace's. */
    & Define.Prop<'zone', string>;

/** Overview: description, environment, stats, the last sessions. Minimal by design (the handoff draws no board for it). */
export const OverviewTab = component<OverviewTabProps>(({ props }) => () => {
    const p = props.profile;
    const sessions = props.sessions ?? sessionRows(p.id);
    const recent = sessions.slice(0, 5);
    return (
        <div data-agent-overview="">
            <Col gap="lg">
                <p data-agent-overview-description="">{p.config.description}</p>
                <Col gap="xs">
                    <Label>Default environment</Label>
                    {p.environment
                        ? <EnvironmentLine machine={p.environment.machine} runtime={p.environment.runtime} account={p.environment.account} tone="live" />
                        : <span data-tone="needs-you">No environment</span>}
                </Col>
                <dl data-agent-stats="">
                    <div><dd>v{props.agent.configVersion}</dd><dt>config</dt></div>
                    <div><dd>{p.memories.length}</dd><dt>memories</dt></div>
                    <div><dd>{p.correctionsThisWeek}</dd><dt>corrections / wk</dt></div>
                    <div><dd>{sessions.length}</dd><dt>sessions</dt></div>
                </dl>
            </Col>
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
                                    <span data-tone="dim">{age(s.startedAt, undefined, props.zone)}</span>
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
