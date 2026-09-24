/**
 * The Add connector page on the platform (#639; PLG-04, AGT-02): what is connected comes from the Registry's
 * connector records (a conduit one once it names an account), the agents from the workspace directory.
 *
 * - Connect, conduit: `Registry.enable` when the plugin is off, then the sign-in route with `?next=agents`, which the
 *   callback turns into this page's agent step.
 * - Connect, MCP: the existing `addConnector()` with what the prefilled form holds.
 * - The agent step: each chosen agent's config with `{ id }` appended to its connectors, saved the way the Config
 *   tab saves (`Agent.update(configPatch(config), reason)`), one new version each. No grant is touched.
 */
import { component, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { agentKeyOf, registryKeyOf } from '../../../actors/keys';
import { connectorStartPath } from '../../../connectors/paths';
import { listingPluginId } from '../../../plugins/listings';
import { useAgentDirectory } from '../../chat/directory';
import { configPatch } from '../../agent/live';
import { addConnector, type ConnectorDraft, type ConnectorProbe } from '../connector';
import { AddConnectorView, type AddConnectorPort } from './AddConnectorView';
import { addedReason, configWithConnector } from './model';

export type LiveAddConnectorProps =
    /** Where Connect sends the browser — `location.assign` by default; tests record it. */
    & Define.Prop<'navigate', (href: string) => void>
    & Define.Prop<'probe', (draft: ConnectorDraft) => Promise<ConnectorProbe>>;

export const LiveAddConnector = component<LiveAddConnectorProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const registryKey = (): string | null => (viewer.workspaceId ? registryKeyOf(viewer.workspaceId) : null);
    const connectors = useActorState(defs.Registry, () => { const k = registryKey(); return k && ([k, 'connectors'] as const); }, { live: true });
    const overview = useActorState(defs.Registry, () => { const k = registryKey(); return k && ([k, 'overview'] as const); }, { live: true });
    const registry = () => actor(defs.Registry, registryKey()!);

    const port: AddConnectorPort = {
        connected: () => new Set((connectors.value ?? []).filter((c) => c.transport !== 'conduit' || c.account !== undefined).map((c) => c.pluginId)),
        taken: () => new Set((overview.value?.plugins ?? []).map((p) => p.manifest.id)),
        agents: () => (directory.loading && directory.all().length === 0 ? null : directory.all().map((a) => ({ id: a.id, name: a.name, role: a.role, hue: a.hue }))),
        async connectConduit(listing) {
            const id = listingPluginId(listing);
            const plugin = await registry().get(id);
            if (!plugin) throw new Error(`This build does not ship ${listing.name}.`);
            if (!plugin.enabled) await registry().enable(id);
            const href = `${connectorStartPath(id)}?next=agents`;
            if (props.navigate) props.navigate(href);
            else location.assign(href);
            return 'redirected';
        },
        addMcp: ({ draft, probe }) => addConnector(registry(), draft, probe),
        async addToAgents(pluginId, name, agentIds) {
            const ws = viewer.workspaceId!;
            for (const agentId of agentIds) {
                const agent = actor(defs.AgentActor, agentKeyOf(ws, agentId));
                const config = configWithConnector((await agent.get()).config, pluginId);
                if (config) await agent.update(configPatch(config), addedReason(name));
            }
        }
    };

    return () => {
        if (!viewer.pending && !viewer.workspaceId) {
            return (
                <section data-page="connector-add" aria-label="Add a connector">
                    <EmptyState variant="generic" title="Sign in to add connectors" caption="Connectors are set up per workspace." />
                </section>
            );
        }
        return <AddConnectorView port={port} {...(props.probe ? { probe: props.probe } : {})} />;
    };
}, { name: 'LiveAddConnector' });
