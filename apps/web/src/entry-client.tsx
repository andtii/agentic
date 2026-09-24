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
import { actorsPlugin, fetchTransport } from '@sigx/actors/app';
import { ACTOR_ENDPOINT, clientDefs } from './actors/client';
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
// The platform actors over the Worker's HTTP mount (#34): calls as POSTs, live reads on one held-open stream.
// Actor refs are hand-built stubs (`actors/client.ts`): the platform's definitions are not `*.actor.ts` modules.
// The transport reports this browser's connection (OPS-04, #46): frames and answers say live, a dropped stream or the network says reconnecting.
app.use(actorsPlugin({ transport: watchTransport(fetchTransport({ endpoint: ACTOR_ENDPOINT })), live: { onError: () => setClientConnection('reconnecting') } }));
installClientConnection();
app.defineProvide(useActorDefs, clientDefs);
app.defineProvide(useViewer, () => viewerHook);
app.use(ssrClientPlugin).hydrate!('#app');
