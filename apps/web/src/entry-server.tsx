import '@agentic/ui/register';
import { defineApp } from 'sigx';
import { installThemes } from '@agentic/ui/design-system';
import { actorsPlugin } from '@sigx/actors/app';
import { useActorDefs, useViewer, type ActorDefs } from './actors/defs';
import { viewerHook } from './actors/viewer';
import { App } from './App';
import { createServerRouter } from './router';

// Once per module, not per request: the registry is write-once configuration.
installThemes();

/**
 * The per-request app factory. Both request handlers consume this export —
 * `createDevRequestHandler` under `vite` and `createRequestHandler` in
 * production — and each call builds a FRESH app, so nothing is shared
 * between concurrent requests. `url` is the requested path. Rendered this way
 * (the Vite dev server, which hosts no actors and renders mock data), no actor
 * definitions are provided.
 */
export function createApp(url: string) {
    return buildApp(url);
}

/**
 * The same factory over a host's actor definitions (#1017): each entry passes
 * the definitions its own host serves (the Worker, `actors.cloudflare.ts`'s
 * registry; the Node host, the definitions off its running host), so this file
 * imports no host wiring and the Node bundle loads nothing of Cloudflare. A
 * separate export because the dev handler calls `createApp` with arguments of
 * its own after `url`.
 */
export function createAppWithDefs(defs: () => ActorDefs): (url: string) => ReturnType<typeof buildApp> {
    return (url) => buildApp(url, defs);
}

function buildApp(url: string, defs?: () => ActorDefs) {
    const app = defineApp(<App />);
    app.use(createServerRouter(url));
    // Actor reads during SSR dispatch in-process through the host seam (the Worker's, routed to the Durable Objects; the Node host's), under the request's principal (#34).
    app.use(actorsPlugin());
    if (defs) app.defineProvide(useActorDefs, defs);
    app.defineProvide(useViewer, () => viewerHook);
    return app;
}
