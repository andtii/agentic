import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxServer } from '@sigx/vite/server';
import { cloudflare } from '@sigx/cloudflare';
import { monacoPrebundledPlugin } from '@sigx/monaco-editor/vite';
import type { SigxAdapter } from '@sigx/vite';

// The code renderer's Monaco (#564): `@sigx/monaco-editor`'s prebundled assets at `/monaco-bundle` — the loader's
// default path, so nothing is configured at runtime (the plugin's `transformIndexHtml` injection never reaches a
// server-rendered document). In dev the plugin serves them; a build emits the files its manifest lists (no source
// maps; the icon font is inlined in the CSS) into the client output, which the Worker serves as static assets.

// Externalized from the dev-server module graph so the app, the request
// handler and the render plugins share one set of @sigx module instances.
const SIGX_FAMILY = ['sigx', '@sigx/server-renderer', '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity', '@sigx/server'];

// The Node host (#988): `vite build --app --mode node` bundles the server as ONE module graph for
// Node — `apps/node/src/main.ts` (which imports `src/entry.node.ts`) into `apps/node/dist/main.js`, so
// the actors, the routes, the server functions and the render share one set of @sigx instances.
// `node:*` and `ws` stay runtime imports (resolved from `apps/node/node_modules`). The client build
// is the same one the Worker serves, in `dist/client`; the Node server reads it from there.
const nodeHost: SigxAdapter = {
    name: 'agentic-node',
    serverBuild: 'bundled',
    conditions: ['node'],
    runtimeExternal: [/^node:/, 'ws'],
    entry: '../node/src/main.ts',
    target: 'node22'
};

export default defineConfig(({ command, mode }) => ({
    plugins: [
        monacoPrebundledPlugin(),
        sigx({
            ssr: mode === 'node'
                ? { entry: 'src/entry-server.tsx', adapter: nodeHost, serverOutDir: '../node/dist' }
                : { entry: 'src/entry-server.tsx', adapter: cloudflare() }
        }),
        sigxServer()
    ],
    // The Node build writes outside this package: clear its previous chunks.
    ...(mode === 'node' && {
        environments: { ssr: { build: { emptyOutDir: true } } }
    }),
    // Lightning CSS compiles the design system's `@custom-media` breakpoints (`@agentic/ui/css/breakpoints`)
    // that the page stylesheets query (`@media (--below-md)`).
    css: {
        transformer: 'lightningcss',
        lightningcss: { drafts: { customMedia: true } }
    },
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    ...(command === 'serve' && {
        ssr: { external: SIGX_FAMILY }
    })
}));
