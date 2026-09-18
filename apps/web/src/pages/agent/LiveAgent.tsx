/**
 * `/agents/:id` on the platform (#35): the Agent actor read live (`get`),
 * its version log (`listVersions`, re-read after every save), the same
 * header and tabs as the mock page over a profile folded from them
 * (`profileOf`), the Config tab persisting through `Agent.update` /
 * `Agent.rollback` — its environment picker offering every paired machine's
 * environments (#144) — and "Start chat" creating a direct chat with this agent.
 *
 * #153: presence and the Sessions tab from the task index, the Memory tab on
 * the agent's private Memory scope, the week's corrections from the Ledger,
 * a pending instruction proposal in the rail (`Agent.reviewProposal`), the
 * form's other pickers from `./catalog`, times in the workspace's zone.
 */
import { component, effect, onUnmounted, signal, useData, type JSXElement } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Tabs } from '@sigx/zero-daisyui/components';
import type { AgentConfig, AgentConfigVersion, MemoryEntry } from '@agentic/core';
import { AgentTile, Button, EmptyState, EnvironmentLine, Row, Stack, StatusPill } from '@agentic/ui';
import { Page } from '../../components/Page';
import { useActorDefs, useViewer } from '../../actors/defs';
import { agentKeyOf, memoryKeyOf } from '../../actors/keys';
import type { MockAgent } from '../../mock/data';
import { useWorkspaceZone } from '../../time';
import { presencePill } from '../Agents';
import { useAgentDirectory } from '../chat/directory';
import { createChatWith } from '../chat/LiveChats';
import { useEnvironmentOptions } from '../machines/environments';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { LiveStartTask } from '../task/LiveStartTask';
import { openStartTask } from '../task/start';
import { AGENT_TABS, type AgentTab } from '../Agent';
import { useAgentActivity } from './activity';
import { useAgentCatalog } from './catalog';
import { ConfigTab, type ConfigStore } from './ConfigTab';
import { agentHead } from './head';
import { configPatch, learningPatch, profileOf, sessionRowsOf } from './live';
import { MemoryTab, type MemoryTabStore } from './MemoryTab';
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
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? agentKeyOf(viewer.workspaceId, props.id) : null);
    const client = () => actor(defs.AgentActor, key()!);

    const view = useActorState(defs.AgentActor, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const activity = useAgentActivity(defs, viewer, () => props.id, () => view.value);
    const catalog = useAgentCatalog(defs, viewer);
    const zone = useWorkspaceZone(defs, viewer);
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
        rollback: (version: number) => client().rollback(version),
        config: async () => (await client().get()).config,
        // The rail shows the oldest pending proposal; accepting lands it as a new version (LRN-08).
        async review(decision) {
            const proposal = activity.activity().proposal;
            if (!proposal) return null;
            const reviewed = await client().reviewProposal(proposal.id, decision);
            if (decision !== 'accept' || reviewed.review?.version === undefined) return null;
            const [versions, after] = await Promise.all([client().listVersions(), client().get()]);
            const version = versions.find((v) => v.version === reviewed.review!.version);
            return version ? { version, config: after.config } : null;
        }
    };

    const memory = () => actor(defs.Memory, memoryKeyOf(viewer.workspaceId!, `agent:${props.id}`));
    const memoryStore: MemoryTabStore = {
        correct: (entry: MemoryEntry, text: string) => memory().update(entry.id, { text, confidence: 'stated', provenance: { ...entry.provenance, source: 'user', at: Date.now() } }),
        retire: (entry: MemoryEntry) => memory().retire(entry.id, 'retired by you'),
        remove: (entry: MemoryEntry) => memory().delete(entry.id),
        setLearning: (on: boolean) => client().update(learningPatch(view.value!.config, on), on ? 'Learning on' : 'Learning off')
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
        // The Config tab copies the versions at mount, so it waits for the log and for a pending proposal.
        if (!v || !log.versions || activity.pending()) return <div data-page="agent" data-agent={id} aria-busy="true" />;
        const index = Math.max(0, directory.all().findIndex((a) => a.id === id));
        const profile = profileOf(v, log.versions, index, activity.activity());
        const pill = presencePill(profile.presence);
        const sessions = sessionRowsOf(activity.activity().tasks ?? [], profile.environment!);
        const agent: MockAgent = { id, name: v.config.name || id, description: v.config.description, runtime: v.config.execution.runtime === 'claude-code' ? 'claude-code' : 'anthropic-api', status: profile.presence === 'idle' ? 'idle' : 'busy', configVersion: v.configVersion };
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
                        <StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} />
                        <Button icon="chats" disabled={st.starting} onClick={() => { void startChat(); }}>Start chat</Button>
                        <Button intent="primary" icon="plus" onClick={() => openStartTask(id)}>Start task</Button>
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
                    <Tabs.Panel value="overview"><OverviewTab profile={profile} agent={agent} sessions={sessions} zone={zone()} /></Tabs.Panel>
                    <Tabs.Panel value="config"><ConfigTab profile={profile} store={store} collaborators={collaborators} environments={environments.options()} catalog={catalog(v.config)} workdirs={workdirs} /></Tabs.Panel>
                    <Tabs.Panel value="memory"><MemoryTab profile={profile} store={memoryStore} zone={zone()} /></Tabs.Panel>
                    <Tabs.Panel value="sessions"><SessionsTab agentId={id} rows={sessions} agent={{ name: agent.name, hue: profile.hue }} zone={zone()} /></Tabs.Panel>
                </Tabs>
                <LiveStartTask />
            </div>
        );
    };
});
