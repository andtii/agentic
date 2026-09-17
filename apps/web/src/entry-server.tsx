import '@agentic/ui/register';
import { defineApp } from 'sigx';
import { installThemes } from '@agentic/ui/design-system';
import { actorsPlugin } from '@sigx/actors/app';
import { platformDefs } from './actors.app';
import { useActorDefs, useViewer } from './actors/defs';
import { viewerHook } from './actors/viewer';
import { App } from './App';
import { createServerRouter } from './router';

// Once per module, not per request: the registry is write-once configuration.
installThemes();

/**
 * The per-request app factory. Both request handlers consume this export —
 * `createDevRequestHandler` under `vite` and `createRequestHandler` in
 * production — and each call builds a FRESH app, so nothing is shared
 * between concurrent requests. `url` is the requested path.
 */
export function createApp(url: string) {
    const app = defineApp(<App />);
    app.use(createServerRouter(url));
    // Actor reads during SSR dispatch in-process through the host seam (the Worker's, routed to the Durable Objects), under the request's principal (#34).
    app.use(actorsPlugin());
    app.defineProvide(useActorDefs, () => platformDefs());
    app.defineProvide(useViewer, () => viewerHook);
    return app;
}
