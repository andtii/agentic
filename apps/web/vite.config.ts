import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxServer } from '@sigx/vite/server';
import { cloudflare } from '@sigx/cloudflare';
import { monacoPrebundledPlugin } from '@sigx/monaco-editor/vite';

// The code renderer's Monaco (#564): `@sigx/monaco-editor`'s prebundled assets at `/monaco-bundle` — the loader's
// default path, so nothing is configured at runtime (the plugin's `transformIndexHtml` injection never reaches a
// server-rendered document). In dev the plugin serves them; a build emits the files its manifest lists (no source
// maps; the icon font is inlined in the CSS) into the client output, which the Worker serves as static assets.

// Externalized from the dev-server module graph so the app, the request
// handler and the render plugins share one set of @sigx module instances.
const SIGX_FAMILY = ['sigx', '@sigx/server-renderer', '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity', '@sigx/server'];

export default defineConfig(({ command }) => ({
    plugins: [
        monacoPrebundledPlugin(),
        sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: cloudflare() } }),
        sigxServer()
    ],
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
