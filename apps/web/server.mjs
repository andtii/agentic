// The server — plain Node, no transpiler. Two modes, one handler each:
//   dev   Vite middleware + createDevRequestHandler (HMR, per-request entry load)
//   prod  static assets + createRequestHandler over the `dist/` build
//
//     node server.mjs                                         # dev
//     NODE_ENV=production node --conditions production server.mjs   # prod
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;

// Crawlers and AI agents get the blocking document: complete content inline,
// nothing for the client to execute.
const isBot = (ua) => /bot|crawl|spider|slurp|gptbot|claudebot|perplexity|headless/i.test(ua);

const app = express();

if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const { createDevRequestHandler } = await import('@sigx/vite/ssr');

    const vite = await createViteServer({
        root: __dirname,
        server: { middlewareMode: true },
        appType: 'custom'
    });
    // In dev, Vite's middleware also carries the server-function endpoint.
    app.use(vite.middlewares);
    app.use(await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx', isBot }));
} else {
    const { createRequestHandler } = await import('@sigx/server-renderer/node');
    const { createServerFnHandler } = await import('@sigx/server/node');
    // The build materializes the document template and asset links as one module.
    const { template, assets } = await import('./dist/server/sigx-app.js');
    const { createApp } = await import('./dist/server/entry-server.js');
    // The server-function registry is passed explicitly, never ambient.
    const { serverFns } = await import('./dist/server/sigx-server-fns.js');

    app.use(express.static(resolve(__dirname, 'dist/client'), { index: false }));
    app.use(createServerFnHandler({
        functions: serverFns,
    }));
    app.use(createRequestHandler({
        template,
        app: (url) => createApp(url),
        isBot,
        document: { assets }
    }));
}

app.listen(port, () => {
    console.log(`[web] ${isProd ? 'production' : 'dev'} server on http://localhost:${port}`);
});
