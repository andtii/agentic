/**
 * `/agents` on the platform (#35): the Workspace's agent index read live,
 * each agent's identity through the chat directory (`Agent.get()` per id),
 * rendered as the same card grid the mock roster draws; "New agent" creates
 * the record (`Workspace.createAgent`) and its first version
 * (`Agent.update(..., 'create')`), then lands on its Config tab. Each card's
 * pill follows the agent's tasks (one read of the task index for the roster)
 * and its stats its own Memory scope and the week's corrections (#153).
 * The dialog offers the enabled runtime plugins and opens on the workspace's
 * `defaults.runtime` (#234).
 */
import { component, signal, useHead, type Define } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { AgentId } from '@agentic/core';
import { AgentTile, EmptyState, EnvironmentLine, Icon, Label, Row, Stack, StatusPill } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs } from '../../actors/defs';
import { agentKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { presencePill } from '../Agents';
import { useAgentCorrections, useMemoryCount, useWorkspaceTasks } from './activity';
import { closeNewAgent, newAgentRequest } from './head';
import { CREATED_REASON, newAgentPatch, presenceOf, tasksByAssignee, type NewAgentInput } from './live';
import { NewAgentDialog } from './NewAgentDialog';
import { useWorkspaceReadiness } from '../plugins/readiness';
import { runtimeOptions } from './runtimes';

/** Create the agent in `ws` with its first config version; resolves to the new id. */
export async function createAgentWith(defs: ActorDefs, ws: string, input: NewAgentInput): Promise<string> {
    const { agentId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createAgent({ name: input.name.trim() });
    await actor(defs.AgentActor, agentKeyOf(ws, agentId)).update(newAgentPatch(input), CREATED_REASON);
    return agentId as AgentId;
}

/** A card's footer stats: each card reads its own agent's Memory scope and corrections, live. */
const CardStats = component<Define.Prop<'agentId', string, true> & Define.Prop<'configVersion', number, true>>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const memories = useMemoryCount(defs, viewer, () => props.agentId);
    const corrections = useAgentCorrections(defs, viewer, () => props.agentId);
    return () => (
        <dl data-agent-card-stats="">
            <div><dd>v{props.configVersion}</dd><dt>config</dt></div>
            <div><dd>{memories()}</dd><dt>memories</dt></div>
            <div><dd>{corrections.week()}</dd><dt>corrections / wk</dt></div>
        </dl>
    );
}, { name: 'AgentCardStats' });

export const LiveAgents = component(() => {
    useHead({ title: 'Agents' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const tasks = useWorkspaceTasks(defs, viewer);
    const readiness = useWorkspaceReadiness(defs, viewer);
    const workspace = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const runtimes = () => { const plugins = readiness.overview()?.plugins; return plugins ? runtimeOptions(plugins, readiness.byId()) : undefined; };
    const st = signal({ busy: false, error: '' });
    const create = async (input: NewAgentInput): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws) return;
        st.busy = true;
        st.error = '';
        try {
            const id = await createAgentWith(defs, ws, input);
            closeNewAgent();
            await router.push(`/agents/${id}?tab=config`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return () => {
        const rows = directory.all();
        const byAgent = tasksByAssignee(tasks());
        const signedOut = !viewer.pending && !viewer.workspaceId;
        return (
            <div data-page="agents" aria-busy={directory.loading ? 'true' : undefined}>
                <div data-page-head="">
                    <h1 data-page-title>Agents</h1>
                </div>
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your agents" caption="Agents belong to your workspace." />
                    : !rows.length && !directory.loading
                        ? <EmptyState variant="generic" title="No agents yet" caption="Create one with New agent; it runs on the platform until you give it an environment." />
                        : (
                            <ul data-agent-grid="" aria-label="Agents">
                                {rows.map((a) => {
                                    const pill = presencePill(presenceOf(byAgent[a.id] ?? []));
                                    return (
                                    <li data-agent-card={a.id}>
                                        <Link to={`/agents/${a.id}`} class="agent-card">
                                            <Row gap="md" align="center">
                                                <AgentTile name={a.name} hue={a.hue} size={44} />
                                                <Stack gap="2xs" grow>
                                                    <span data-agent-card-name="">{a.name}</span>
                                                    <span data-agent-card-role="">{a.role}</span>
                                                </Stack>
                                                <StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} />
                                            </Row>
                                            <p data-agent-card-description="">{a.description ?? ''}</p>
                                            <Stack gap="xs">
                                                <Label>Default environment</Label>
                                                <EnvironmentLine machine={a.environment.machine} runtime={a.environment.runtime} account={a.environment.account} tone="live" />
                                            </Stack>
                                            <CardStats agentId={a.id} configVersion={a.configVersion} />
                                        </Link>
                                    </li>
                                    );
                                })}
                            </ul>
                        )}
                {st.error ? <p data-agent-error role="alert">{st.error}</p> : null}
                <p data-agent-grid-footer="">
                    <Icon name="delegate" size={14} />
                    <span>Agents may delegate to every agent in this workspace. Depth 3, concurrency 3, budgets split from the parent.</span>
                </p>
                <NewAgentDialog model={() => newAgentRequest.open} busy={st.busy} runtimes={runtimes()} defaultRuntime={workspace.value?.settings.defaults.runtime} onCancel={closeNewAgent} onCreate={(e) => { void create(e); }} />
            </div>
        );
    };
});
