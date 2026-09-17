import '@sigx/zero-daisyui/register';
import { defineApp } from 'sigx';
import { installThemes } from '@sigx/zero-daisyui';
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
    return app;
}
