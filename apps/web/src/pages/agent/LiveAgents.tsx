/**
 * `/agents` on the platform (#35): the Workspace's agent index read live,
 * each agent's identity through the chat directory (`Agent.get()` per id),
 * rendered as the same card grid the mock roster draws; "New agent" creates
 * the record (`Workspace.createAgent`) and its first version
 * (`Agent.update(..., 'create')`), then lands on its Config tab.
 */
import { component, signal, useHead } from 'sigx';
import { Link, useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import type { AgentId } from '@agentic/core';
import { AgentTile, EmptyState, EnvironmentLine, Icon, Label, Row, Stack, StatusPill } from '@agentic/ui';
import { useActorDefs, useViewer, type ActorDefs } from '../../actors/defs';
import { agentKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { closeNewAgent, newAgentRequest } from './head';
import { CREATED_REASON, newAgentPatch, type NewAgentInput } from './live';
import { NewAgentDialog } from './NewAgentDialog';

/** Create the agent in `ws` with its first config version; resolves to the new id. */
export async function createAgentWith(defs: ActorDefs, ws: string, input: NewAgentInput): Promise<string> {
    const { agentId } = await actor(defs.Workspace, workspaceKeyOf(ws)).createAgent({ name: input.name.trim() });
    await actor(defs.AgentActor, agentKeyOf(ws, agentId)).update(newAgentPatch(input), CREATED_REASON);
    return agentId as AgentId;
}

export const LiveAgents = component(() => {
    useHead({ title: 'Agents' });
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
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
                                {rows.map((a) => (
                                    <li data-agent-card={a.id}>
                                        <Link to={`/agents/${a.id}`} class="agent-card">
                                            <Row gap="md" align="center">
                                                <AgentTile name={a.name} hue={a.hue} size={44} />
                                                <Stack gap="2xs" grow>
                                                    <span data-agent-card-name="">{a.name}</span>
                                                    <span data-agent-card-role="">{a.role}</span>
                                                </Stack>
                                                <StatusPill status="idle" label="IDLE" hollow />
                                            </Row>
                                            <p data-agent-card-description="">{a.description ?? ''}</p>
                                            <Stack gap="xs">
                                                <Label>Default environment</Label>
                                                <EnvironmentLine machine={a.environment.machine} runtime={a.environment.runtime} account={a.environment.account} tone="live" />
                                            </Stack>
                                            <dl data-agent-card-stats="">
                                                <div><dd>v{a.configVersion}</dd><dt>config</dt></div>
                                                <div><dd>0</dd><dt>memories</dt></div>
                                                <div><dd>0</dd><dt>corrections / wk</dt></div>
                                            </dl>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                {st.error ? <p data-agent-error role="alert">{st.error}</p> : null}
                <p data-agent-grid-footer="">
                    <Icon name="delegate" size={14} />
                    <span>Agents may delegate to every agent in this workspace. Depth 3, concurrency 3, budgets split from the parent.</span>
                </p>
                <NewAgentDialog model={() => newAgentRequest.open} busy={st.busy} onCancel={closeNewAgent} onCreate={(e) => { void create(e); }} />
            </div>
        );
    };
});
