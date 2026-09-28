/**
 * `agentic` (`bin/agentic.mjs`, #990) / `node apps/node/dist/main.js` — the
 * whole platform on one machine (#988): the actors on `sqliteStorage`
 * (`<home>/agentic.db`), chat files on disk (`<home>/files`), the Worker's
 * HTTP routes, the live actor sockets and the daemon socket, on one port
 * (`--port`, `PORT`, default 8787) — and this machine's daemon in the same
 * process, paired to the local owner (`start.ts`; `--no-daemon` opts out).
 *
 * Built by `pnpm --filter @agentic/node bundle` (the web app's Vite build with
 * `--mode node`, so the server functions and the document render bundle in;
 * the daemon is built beside it and loaded at run time). SIGINT / SIGTERM
 * stop the daemon, then drain: new responses carry `connection: close`, the
 * host finishes its turns and flushes state, then the listener and the
 * database close.
 *
 * `agentic status` reports; `agentic export …` / `agentic import …` move a
 * Cloudflare deployment's state to this node instead of serving (`./import/cli.ts`, #994).
 */
import { nodeFallback } from '../../web/src/entry.node';
import { openHomeFor, parseCli, statusLines, USAGE } from './cli';
import { openHome } from './home';
import { runImportCli } from './import/cli';
import { startNode } from './start';

const command = parseCli(process.argv.slice(2));
switch (command.kind) {
    case 'help':
        console.log(USAGE);
        process.exit(0);
        break;
    case 'error':
        console.error(`agentic: ${command.message}\n\n${USAGE}`);
        process.exit(2);
        break;
    case 'import':
        process.exit(await runImportCli(command.argv, openHome()));
        break;
    case 'status':
        for (const line of await statusLines({ home: openHomeFor(command) })) console.log(line);
        process.exit(0);
        break;
    case 'start': {
        const running = await startNode({ home: openHomeFor(command), daemon: command.daemon, open: command.open, fallback: nodeFallback });
        let stopping = false;
        const shutdown = async (signal: string): Promise<void> => {
            if (stopping) return;
            stopping = true;
            console.log(`[node] ${signal}: stopping`);
            await running.stop();
            process.exit(0);
        };
        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));
        break;
    }
}
