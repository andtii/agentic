import { component, useHead } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, EnvironmentLine, Icon, Label, StatusPill } from '@agentic/ui';
import { Col, Row, Stack } from '@sigx/zero';
import { agentProfiles, type AgentProfile } from '../mock/agents';
import { defineTopbar } from '../components/topbar';
import { dataMode } from '../data-mode';
import { openNewAgent } from './agent/head';
import { LiveAgents } from './agent/LiveAgents';

/** The roster's status pill: the agent's presence in the handoff's vocabulary. */
export function presencePill(presence: AgentProfile['presence']): { status: string; label?: string; hollow?: boolean } {
    return presence === 'idle' ? { status: 'idle', label: 'IDLE', hollow: true } : { status: presence };
}

/**
 * `/agents` — the roster (`docs/design/HANDOFF.md` → Screen specs, Agents):
 * two equal columns of card links, the whole card is the link, footer stats
 * in mono (config version, memory count, corrections per week — LRN-09).
 * A `claude-code` agent without an environment shows `No environment`.
 */
// The button opens the live roster's dialog (#35); the mock page mounts none, so there it stays the artboard's inert control.
defineTopbar('agents', () => ({ actions: () => <Button intent="primary" icon="plus" onClick={dataMode() === 'live' ? openNewAgent : undefined}>New agent</Button> }));

/** `/agents`: the workspace's agents on the platform (`LiveAgents`, #35), or the mock roster. */
export const Agents = component(() => {
    useHead({ title: 'Agents' });
    return () => {
        if (dataMode() === 'live') return <LiveAgents />;
        const rows = agentProfiles();
        return (
                <div data-page="agents">
                    <div data-page-head="">
                        <h1 data-page-title>Agents</h1>
                    </div>
                    <ul data-agent-grid="" aria-label="Agents">
                        {rows.map((p) => {
                            const pill = presencePill(p.presence);
                            return (
                                <li data-agent-card={p.id}>
                                    <Link to={`/agents/${p.id}`} class="agent-card">
                                        <Row gap="md" align="center">
                                            <AgentTile name={p.config.name} hue={p.hue} size={44} />
                                            <Stack.Item grow>
                                                <Col gap="2xs">
                                                    <span data-agent-card-name="">{p.config.name}</span>
                                                    <span data-agent-card-role="">{p.role}</span>
                                                </Col>
                                            </Stack.Item>
                                            <StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} />
                                        </Row>
                                        <p data-agent-card-description="">{p.config.description}</p>
                                        <Col gap="xs">
                                            <Label>Default environment</Label>
                                            {p.environment
                                                ? <EnvironmentLine machine={p.environment.machine} runtime={p.environment.runtime} account={p.environment.account} tone="live" />
                                                : <span data-agent-card-noenv="" data-tone="needs-you">No environment</span>}
                                        </Col>
                                        <dl data-agent-card-stats="">
                                            <div><dd>v{p.agent.configVersion}</dd><dt>config</dt></div>
                                            <div><dd>{p.memories.length}</dd><dt>memories</dt></div>
                                            <div><dd>{p.correctionsThisWeek}</dd><dt>corrections / wk</dt></div>
                                        </dl>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                    <p data-agent-grid-footer="">
                        <Icon name="delegate" size={14} />
                        <span>Agents may delegate to every agent in this workspace. Depth 3, concurrency 3, budgets split from the parent.</span>
                    </p>
                </div>
        );
    };
});
