import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxServer } from '@sigx/vite/server';
import { cloudflare } from '@sigx/cloudflare';

// Externalized from the dev-server module graph so the app, the request
// handler and the render plugins share one set of @sigx module instances.
const SIGX_FAMILY = ['sigx', '@sigx/server-renderer', '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity', '@sigx/server'];

export default defineConfig(({ command }) => ({
    plugins: [
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
