import { component, signal, useHead } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { Tabs } from '@sigx/zero-daisyui/components';
import { AgentTile, Button, EmptyState, EnvironmentLine, Row, Stack, StatusPill } from '@agentic/ui';
import { Page } from '../components/Page';
import { agentById } from '../mock/data';
import { agentProfile } from '../mock/agents';
import { defineTopbar, routeId } from '../components/topbar';
import { presencePill } from './Agents';
import { OverviewTab } from './agent/OverviewTab';
import { ConfigTab } from './agent/ConfigTab';
import { MemoryTab } from './agent/MemoryTab';
import { SessionsTab } from './agent/SessionsTab';

export const AGENT_TABS = ['overview', 'config', 'memory', 'sessions'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/**
 * `/agents/:id` — header (tile 52, name 24 / 600, role, environment line,
 * status pill) over Overview | Config | Memory | Sessions
 * (`docs/design/HANDOFF.md` → Screen specs, Agent config / Agent memory).
 * `?tab=` selects the tab on load so a link can land on Config or Memory.
 */
defineTopbar('agent', (route) => {
    const id = routeId(route);
    const profile = agentProfile(id);
    return {
        crumb: agentById(id)?.name,
        subtitle: profile ? () => <span>{profile.role}</span> : undefined
    };
});

export const Agent = component(() => {
    const route = useRoute();
    useHead({ title: agentById(String(route.params.id))?.name ?? 'Agent not found' });
    const initial = (): AgentTab => {
        const q = String(route.query.tab ?? '');
        return (AGENT_TABS as readonly string[]).includes(q) ? (q as AgentTab) : 'overview';
    };
    const state = signal({ tab: initial() });

    return () => {
        const id = String(route.params.id);
        const agent = agentById(id);
        const profile = agentProfile(id);
        if (!agent || !profile) {
            return (
                <Page title="Agent not found">
                    <EmptyState variant="generic" title={`No agent with id ${id}`} caption="It may have been deleted, or the link is stale." slots={{ actions: () => <Link to="/agents">All agents</Link> }} />
                </Page>
            );
        }
        const pill = presencePill(profile.presence);
        return (
                <div data-page="agent" data-agent={id}>
                    <header data-agent-header="">
                        <Row gap="lg" align="center">
                            <AgentTile name={agent.name} hue={profile.hue} size={52} />
                            <Stack gap="2xs">
                                <h1 data-page-title data-agent-name="">{agent.name}</h1>
                                <div data-agent-sub="">
                                    <span data-agent-role="">{profile.role}</span>
                                    {profile.environment
                                        ? <EnvironmentLine machine={profile.environment.machine} runtime={profile.environment.runtime} account={profile.environment.account} fit="drop-machine" />
                                        : <span data-agent-noenv="" data-tone="needs-you">No environment</span>}
                                </div>
                            </Stack>
                        </Row>
                        <Row gap="md" align="center">
                            <StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} />
                            <Button icon="chats">Start chat</Button>
                        </Row>
                    </header>
                    <Tabs model={() => state.tab}>
                        <Tabs.List>
                            <Tabs.Tab value="overview">Overview</Tabs.Tab>
                            <Tabs.Tab value="config">Config</Tabs.Tab>
                            <Tabs.Tab value="memory">Memory</Tabs.Tab>
                            <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
                        </Tabs.List>
                        <Tabs.Panel value="overview"><OverviewTab profile={profile} agent={agent} /></Tabs.Panel>
                        <Tabs.Panel value="config"><ConfigTab profile={profile} /></Tabs.Panel>
                        <Tabs.Panel value="memory"><MemoryTab profile={profile} /></Tabs.Panel>
                        <Tabs.Panel value="sessions"><SessionsTab agentId={id} /></Tabs.Panel>
                    </Tabs>
                </div>
        );
    };
});
