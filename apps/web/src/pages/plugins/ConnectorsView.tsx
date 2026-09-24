/**
 * `/plugins?kind=connector` (#628, a stub for #638): the workspace's MCP
 * servers (`LiveConnectors`) on the platform; on mock data, the catalogue
 * as `/plugins` draws it until the Connectors view lands.
 */
import { component } from 'sigx';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { registryKeyOf } from '../../actors/keys';
import { dataMode } from '../../data-mode';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { LiveConnectors } from './LiveConnectors';
import { PluginsList } from './PluginsList';
import { useWorkspaceReadiness } from './readiness';

const LiveConnectorsView = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const agents = useAgentDirectory(defs, viewer);
    const ready = useWorkspaceReadiness(defs, viewer);
    return () => {
        const signedOut = !viewer.pending && !viewer.workspaceId;
        return (
            <OpsPage page="plugins" title="Connectors">
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your plugins" caption="Plugins are set up per workspace." />
                    : viewer.workspaceId
                        ? (
                            <LiveConnectors
                                defs={defs}
                                registryKey={registryKeyOf(viewer.workspaceId)}
                                pluginIds={ready.overview()?.plugins.map((p) => p.manifest.id) ?? []}
                                agentName={(id: string) => agents.lookup(id).name}
                            />
                        )
                        : null}
            </OpsPage>
        );
    };
});

export const ConnectorsView = component(() => () => (dataMode() === 'live' ? <LiveConnectorsView /> : <PluginsList kind="connector" />));
