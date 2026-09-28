/**
 * `node apps/node/dist/main.js` — the whole platform on one machine (#988):
 * the actors on `sqliteStorage` (`<home>/agentic.db`), chat files on disk
 * (`<home>/files`), the Worker's HTTP routes, the live actor sockets and the
 * daemon socket, on one port (`PORT`, default 8787).
 *
 * Built by `pnpm --filter @agentic/node bundle` (the web app's Vite build with
 * `--mode node`, so the server functions and the document render bundle in).
 * SIGINT / SIGTERM drain: new responses carry `connection: close`, the host
 * finishes its turns and flushes state, then the listener and the database
 * close.
 */
import { fileURLToPath } from 'node:url';
import { sqliteStorage } from '@sigx/actors-sqlite';
import { nodeFallback } from '../../web/src/entry.node';
import { fsBucket } from './fs-bucket';
import { openHome } from './home';
import { createNodeHost } from './host';
import { claimUrl, fileLocalOwnerStore, LOCAL_LOGIN_PATH, prepareClaim } from './local-owner';
import { createNodeServer } from './server';

/** How long a shutdown waits for in-flight turns before it closes anyway. */
const STOP_TIMEOUT_MS = 20_000;

const home = openHome();
for (const name of home.generated) console.log(`[node] generated ${name} in ${home.envFile}`);

// The local owner (#989): until someone claims the node, a single-use link to do it.
const localOwner = fileLocalOwnerStore(home.dir);
const claimToken = await prepareClaim(localOwner, home.env.SESSION_SECRET!);

const storage = sqliteStorage({ path: home.database });
const node = await createNodeHost({ storage, bucket: fsBucket(home.files), env: home.env, fallback: nodeFallback, localOwner });
const clientDir = fileURLToPath(new URL('../../web/dist/client', import.meta.url));
const { server, draining } = createNodeServer({ host: node, clientDir });

server.listen(home.port, () => {
    const origin = home.env.APP_ORIGIN!;
    console.log(`[node] agentic on ${origin} — data in ${home.dir}`);
    if (claimToken) console.log(`[node] claim this node (once, within 24 h): ${claimUrl(origin, claimToken)}`);
    else console.log(`[node] sign in: ${origin}${LOCAL_LOGIN_PATH}`);
    if (home.env.AGENTIC_DEV_LOGIN) console.log(`[node] dev login: ${origin}/auth/dev-login?token=${home.env.AGENTIC_DEV_LOGIN}`);
});

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[node] ${signal}: draining`);
    draining();
    try {
        await node.stop({ timeoutMs: STOP_TIMEOUT_MS });
    } catch (e) {
        console.error('[node] the host did not stop cleanly:', e);
    }
    server.close();
    server.closeAllConnections();
    storage.close();
    process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
