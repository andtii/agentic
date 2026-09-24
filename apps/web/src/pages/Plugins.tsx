import { component } from 'sigx';
import { useRoute } from '@sigx/router';
import { queryOf } from './session/files';
import { ConnectorsView } from './plugins/ConnectorsView';
import { PluginsLayout } from './plugins/PluginsLayout';
import { PluginsList } from './plugins/PluginsList';

export { PluginsView, mockAgentOf, mockPluginFacts, type PluginsViewProps } from './plugins/PluginsList';

/**
 * `/plugins`: the plugins layout around one view picked by `?kind=` —
 * `connector` is the Connectors view, anything else the catalogue (#628).
 */
export const Plugins = component(() => {
    const route = useRoute();
    return () => {
        const kind = queryOf(route.query.kind);
        return (
            <PluginsLayout kind={kind}>
                {kind === 'connector' ? <ConnectorsView /> : <PluginsList kind={kind} />}
            </PluginsLayout>
        );
    };
});
