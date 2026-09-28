import '@sigx/zero/css';
import '@agentic/ui/css';
import '@agentic/ui/shell.css';
import './styles.css';
import './styles/pages.css';
import './styles/plugins.css';
// Empty at runtime: augments `@sigx/zero`'s vocabulary with the theme, properties and per-scope axes.
import '@agentic/ui/register';
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { actorsPlugin } from '@sigx/actors/app';
import { clientDefs } from './actors/client';
import { pageTransport } from './actors/page-transport';
import { installClientConnection, setClientConnection, watchTransport } from './components/status';
import { useActorDefs, useViewer } from './actors/defs';
import { viewerHook } from './actors/viewer';
import { installThemes } from '@agentic/ui/design-system';
import { App } from './App';
import { createAppRouter } from './router';

// Seed zero's theme registry with the design system's one theme before
// anything reads it. `<html data-theme="control-room">` is set in the
// document; the persisted choice (none in v1) would be restored before
// first paint by `themeInitScript` in <head>.
installThemes();

// Hydrate the server-rendered HTML in place. `hydrate()` is installed by
// ssrClientPlugin (declared optional on App, hence the `!`).
const app = defineApp(<App />);
app.use(createAppRouter());
// The platform actors over the Worker (#34, #713): calls as POSTs on the HTTP mount; live reads on one hibernatable
// socket per actor (`/_sigx/socket/{type}/{key}`, #712), opened with its first subscription and closed with its last.
// No page opens the NDJSON `$live` stream (#715): the transport always has a live channel (`actors/page-transport.ts`).
// Actor refs are hand-built stubs (`actors/client.ts`): the platform's definitions are not `*.actor.ts` modules.
// The transport reports this browser's connection (OPS-04, #46): an open socket or an answered call says live, a
// dropped socket or the network says reconnecting.
const socketReport = { onOpen: () => setClientConnection('live'), onDrop: () => setClientConnection('reconnecting') };
const transport = pageTransport({ report: socketReport });
app.use(actorsPlugin({ transport: watchTransport(transport), live: { onError: () => setClientConnection('reconnecting') } }));
installClientConnection();
app.defineProvide(useActorDefs, clientDefs);
app.defineProvide(useViewer, () => viewerHook);
app.use(ssrClientPlugin).hydrate!('#app');
