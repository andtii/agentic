import { component } from 'sigx';
import { OpsPage } from './ops/OpsPage';

/** `/plugins/connectors/add` (#628): a stub the Add connector page (#639) fills. Its trail is `crumbs.ts`'s. */
export const AddConnector = component(() => () => <OpsPage page="connector-add" title="Add a connector">{null}</OpsPage>);
