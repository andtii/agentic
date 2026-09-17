// The Cloudflare Worker entry. Static assets never reach this code —
// wrangler's `assets` config (wrangler.jsonc) serves matching files before
// the worker runs. What is left, in order:
//
//     server functions  ->  document render
import { createFetchHandler } from '@sigx/server-renderer/server';
import { template, assets } from 'virtual:sigx-app';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { serverFns, serverFnBase } from 'virtual:sigx-server-fns';
import { createApp } from './entry-server';

const handler = createFetchHandler({
    template,
    app: (url) => createApp(url),
    document: { assets }
});


export default {
    async fetch(request: Request): Promise<Response> {
        if (matchesServerFn(request, serverFnBase)) {
            return handleServerFnRequest(request, {
                // The build's own mount path, so router and handler cannot disagree.
                base: serverFnBase,
                // The registry is passed explicitly, never ambient.
                resolve: (symbol) => serverFns[symbol]?.() ?? null,
            });
        }
        return handler(request);
    }
};
