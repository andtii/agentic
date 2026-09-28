// The web half of the Node host (#988): what `apps/node` cannot build without the Vite plugin's
// virtual modules — the server functions and the document render. `apps/node/src/main.ts` is the
// Node build's input (`vite build --app --mode node`, see vite.config.ts) and hands `nodeFallback`
// to the actor mount, so a request that no auth / A2A / files / connector route and no actor
// route owns ends here, in the Worker's order:
//
//     server functions  ->  document render
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
import { currentHost, type Host } from '@sigx/actors';
import type { ActorDefs } from './actors/defs';
import { createAppWithDefs } from './entry-server';
import { hostDefs } from './platform.app';

let cached: { readonly host: Host; readonly defs: ActorDefs } | undefined;
/**
 * The SSR definitions (#1017): the Node host's own, read off the host the render runs under (`createNodeHost`'s
 * `fetch` enters `runWithHost` before the fallback), never `actors.cloudflare.ts` — nothing of Cloudflare loads here.
 */
function nodeDefs(): ActorDefs {
    const host = currentHost();
    if (cached?.host !== host) cached = { host, defs: hostDefs(host) };
    return cached.defs;
}

const render = createFetchHandler({
    template,
    app: createAppWithDefs(nodeDefs),
    document: { assets }
});

/** Server functions (the build's own mount path and registry, passed explicitly), then the document. */
export function nodeFallback(request: Request): Response | Promise<Response> {
    if (matchesServerFn(request, serverFnBase)) return handleServerFnRequest(request, { base: serverFnBase, functions: serverFns });
    return render(request);
}
