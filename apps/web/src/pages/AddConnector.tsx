import { component } from 'sigx';
import { dataMode } from '../data-mode';
import { AddConnectorView, type AddConnectorPort } from './plugins/add/AddConnectorView';
import { LiveAddConnector } from './plugins/add/live';
import { mockAddConnectorPort } from './plugins/add/mock';

/**
 * `/plugins/connectors/add` (#639): browse the installable connectors, preview one, connect it, then choose the
 * agents that get it — on the platform (`LiveAddConnector`) or over the mock workspace. Its trail is `crumbs.ts`'s.
 */
export const AddConnector = component(() => {
    let mock: AddConnectorPort | undefined;
    return () => (dataMode() === 'live' ? <LiveAddConnector /> : <AddConnectorView port={(mock ??= mockAddConnectorPort())} />);
});
