/**
 * `/agents/:id` on the platform (#35): the Agent actor read live (`get`),
 * its version log (`listVersions`, re-read after every save), the same
 * header and tabs as the mock page over a profile folded from them
 * (`profileOf`), the Config tab persisting through `Agent.update` /
 * `Agent.rollback` — its environment picker offering every paired machine's
 * environments (#144) — and "Start chat" creating a direct chat with this agent.
 */
import { component, effect, onUnmounted, signal, useData, type JSXElement } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Tabs } from '@sigx/zero-daisyui/components';
import type { AgentConfig, AgentConfigVersion } from '@agentic/core';
import { AgentTile, Button, EmptyState, EnvironmentLine, Row, Stack, StatusPill } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer } from '../../actors/defs';
import { agentKeyOf } from '../../actors/keys';
import type { MockAgent } from '../../mock/data';
import { useAgentDirectory } from '../chat/directory';
import { createChatWith } from '../chat/LiveChats';
import { useEnvironmentOptions } from '../machines/environments';
import { AGENT_TABS, type AgentTab } from '../Agent';
import { ConfigTab, type ConfigStore } from './ConfigTab';
import { agentHead } from './head';
import { configPatch, profileOf } from './live';
import { MemoryTab } from './MemoryTab';
import { OverviewTab } from './OverviewTab';
import { SessionsTab } from './SessionsTab';

export const LiveAgent = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const route = useRoute();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    // The paired machines' environments, for the Config tab's default-environment picker (#144).
    const environments = useEnvironmentOptions(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? agentKeyOf(viewer.workspaceId, props.id) : null);
    const client = () => actor(defs.AgentActor, key()!);

    const view = useActorState(defs.AgentActor, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    // Keyed by the config version, so a save (ours or another tab's) re-reads the log.
    const versions = useData(
        () => { const k = key(); return k && view.value ? (['agent-versions', k, view.value.configVersion] as const) : false; },
        () => client().listVersions()
    );

    // The last log read survives a re-read (a key change may pass through pending), so the tabs never unmount on a save.
    const log = signal<{ versions: readonly AgentConfigVersion[] | null }>({ versions: null });
    const stopLog = effect(() => { if (versions.value) log.versions = versions.value; });
    onUnmounted(stopLog);

    const initial = (): AgentTab => {
        const q = String(route.query.tab ?? '');
        return (AGENT_TABS as readonly string[]).includes(q) ? (q as AgentTab) : 'overview';
    };
    const st = signal({ tab: initial(), starting: false, error: '' });

    const stopHead = effect(() => {
        const v = view.value;
        agentHead.value = v ? { id: props.id, name: v.config.name || v.id, role: v.config.role } : null;
    });
    onUnmounted(stopHead);

    const store: ConfigStore = {
        save: (config: AgentConfig, reason: string) => client().update(configPatch(config), reason),
        rollback: (version: number) => client().rollback(version)
    };

    const startChat = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.starting) return;
        st.starting = true;
        st.error = '';
        try {
            const chatId = await createChatWith(defs, ws, [props.id], null);
            await router.push(`/chats/${chatId}`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.starting = false;
        }
    };

    return (): JSXElement => {
        const v = view.value;
        const id = props.id;
        if (view.state === 'errored' || (!viewer.pending && !viewer.workspaceId)) {
            return (
                <Page title="Agent not found">
                    <EmptyState
                        variant="generic"
                        title={viewer.workspaceId ? `No agent with id ${id}` : 'Sign in to see your agents'}
                        caption={viewer.workspaceId ? (view.error?.message ?? 'It may have been deleted, or the link is stale.') : 'Agents belong to your workspace.'}
                        slots={{ actions: () => <Link to="/agents">All agents</Link> }}
                    />
                </Page>
            );
        }
        if (!v || !log.versions) return <div data-page="agent" data-agent={id} aria-busy="true" />;
        const index = Math.max(0, directory.all().findIndex((a) => a.id === id));
        const profile = profileOf(v, log.versions, index);
        const agent: MockAgent = { id, name: v.config.name || id, description: v.config.description, runtime: v.config.execution.runtime === 'claude-code' ? 'claude-code' : 'anthropic-api', status: 'idle', configVersion: v.configVersion };
        const collaborators = directory.all().filter((a) => a.id !== id).map((a) => ({ value: a.id, label: a.name }));
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
                        <StatusPill status="idle" label="IDLE" hollow />
                        <Button icon="chats" disabled={st.starting} onClick={() => { void startChat(); }}>Start chat</Button>
                    </Row>
                </header>
                {st.error ? <p data-agent-error role="alert">{st.error}</p> : null}
                <Tabs model={() => st.tab}>
                    <Tabs.List>
                        <Tabs.Tab value="overview">Overview</Tabs.Tab>
                        <Tabs.Tab value="config">Config</Tabs.Tab>
                        <Tabs.Tab value="memory">Memory</Tabs.Tab>
                        <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="overview"><OverviewTab profile={profile} agent={agent} /></Tabs.Panel>
                    <Tabs.Panel value="config"><ConfigTab profile={profile} store={store} collaborators={collaborators} environments={environments.options()} /></Tabs.Panel>
                    <Tabs.Panel value="memory"><MemoryTab profile={profile} /></Tabs.Panel>
                    <Tabs.Panel value="sessions"><SessionsTab agentId={id} /></Tabs.Panel>
                </Tabs>
            </div>
        );
    };
});
