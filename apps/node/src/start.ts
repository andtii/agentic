/**
 * `agentic start` (#990): the whole platform on this machine, and this
 * machine as its first runtime machine.
 *
 * 1. `prepareClaim`: while nobody owns the node, the claim link (#989).
 * 2. The host on `sqliteStorage`, listening on `home.port`.
 * 3. Unless `daemon: false` (`--no-daemon`): `ensureLocalMachine` pairs this
 *    machine to the local owner's workspace without a code (or keeps the
 *    pairing it has), and the daemon runs IN THIS PROCESS — `agentic-daemon
 *    run`'s own `main(['run'])` over `<home>/daemon`, dialling
 *    `ws://127.0.0.1:PORT`. The wire is the one a remote daemon speaks, so
 *    other machines still pair the normal way.
 * 4. The browser opens on the claim link, or on the app once claimed.
 *
 * `stop` ends the daemon first (its sessions close as a restart, #363), then
 * drains the host and closes the listener and the database.
 */
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { LOCAL_OWNER_ID, machineKey } from '@agentic/platform';
import { sqliteStorage } from '@sigx/actors-sqlite';
import type { CliContext } from '../../daemon/src/cli';
import type { NodeHost, NodeHostOptions } from './host';
import { createNodeHost } from './host';
import type { NodeHome } from './home';
import { claimUrl, fileLocalOwnerStore, LOCAL_LOGIN_PATH, prepareClaim } from './local-owner';
import { ensureLocalMachine, localDaemonPaths, localPlatformUrl } from './local-machine';
import { createNodeServer } from './server';
import { fsBucket } from './fs-bucket';

/** How long a shutdown waits for in-flight turns before it closes anyway. */
const STOP_TIMEOUT_MS = 20_000;
/** How long a shutdown waits for the daemon to close its sessions. */
const DAEMON_STOP_TIMEOUT_MS = 10_000;

/** `agentic-daemon`'s `main`: `argv` and the injectable context, the exit code once `run` ends. */
export type DaemonMain = (argv: readonly string[], context: CliContext) => Promise<number>;

/**
 * The daemon's built CLI beside this app's build: `apps/node/dist/main.js` and `apps/node/src/start.ts` both reach
 * `apps/daemon/dist/cli.js` two levels up. Loaded at run time, never bundled: the daemon brings the runtimes' SDKs
 * and their native builds, which resolve from its own `node_modules`.
 */
export const loadDaemonMain = async (): Promise<DaemonMain> => {
    const entry = new URL('../../daemon/dist/cli.js', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ entry)) as { main: DaemonMain };
    return mod.main;
};

/** Runs the OS opener detached (`cmd /c start ""` on Windows, `open` on macOS, `xdg-open` elsewhere); never throws. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
    try {
        const child =
            platform === 'win32'
                ? spawn(`cmd /c start "" "${url.replace(/"/g, '\\"')}"`, { shell: true, stdio: 'ignore', windowsHide: true, detached: true })
                : spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        // No browser here (a server, a container): the link is printed anyway.
    }
}

export interface StartOptions {
    readonly home: NodeHome;
    /** Run the daemon in this process. Default `true`; `--no-daemon` → hub only. */
    readonly daemon?: boolean;
    /** Open the browser once listening. Default `true`. */
    readonly open?: boolean;
    readonly log?: (line: string) => void;
    /** Default `loadDaemonMain()`. */
    readonly daemonMain?: () => Promise<DaemonMain>;
    /** More of the daemon's context (tests: drivers, timings, output). */
    readonly daemonContext?: Partial<CliContext>;
    /** Default `openBrowser`. */
    readonly opener?: (url: string) => void;
    /** What `NodeHost.fetch` does not own; default none (tests). `main.ts` passes the SSR fallback. */
    readonly fallback?: NodeHostOptions['fallback'];
    readonly clientDir?: string;
    /** PBKDF2 iterations for the owner's passphrase (tests). */
    readonly passphraseIterations?: number;
}

export interface RunningNode {
    readonly node: NodeHost;
    readonly server: Server;
    /** Where the app is (`APP_ORIGIN`). */
    readonly origin: string;
    /** The claim link while nobody owns the node. */
    readonly claimLink: string | null;
    /** The local machine's id once the in-process daemon runs; `null` with `daemon: false`. */
    readonly machineId: string | null;
    /** The in-process daemon's exit code once it ended (`null` without one). */
    readonly daemonExited: Promise<number | null>;
    stop(): Promise<void>;
}

export async function startNode(options: StartOptions): Promise<RunningNode> {
    const { home } = options;
    const log = options.log ?? console.log;
    for (const name of home.generated) log(`[node] generated ${name} in ${home.envFile}`);

    const localOwner = fileLocalOwnerStore(home.dir);
    const claimToken = await prepareClaim(localOwner, home.env.SESSION_SECRET!);

    const storage = sqliteStorage({ path: home.database });
    const node = await createNodeHost({
        storage,
        bucket: fsBucket(home.files),
        env: home.env,
        localOwner,
        ...(options.fallback ? { fallback: options.fallback } : {}),
        ...(options.passphraseIterations ? { passphraseIterations: options.passphraseIterations } : {})
    });
    const clientDir = options.clientDir ?? fileURLToPath(new URL('../../web/dist/client', import.meta.url));
    const { server, draining } = createNodeServer({ host: node, clientDir });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(home.port, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : home.port;
    const origin = home.env.APP_ORIGIN!;
    const claimLink = claimToken ? claimUrl(origin, claimToken) : null;
    log(`[node] agentic on ${origin} — data in ${home.dir}`);
    if (claimLink) log(`[node] claim this node (once, within 24 h): ${claimLink}`);
    else log(`[node] sign in: ${origin}${LOCAL_LOGIN_PATH}`);
    if (home.env.AGENTIC_DEV_LOGIN) log(`[node] dev login: ${origin}/auth/dev-login?token=${home.env.AGENTIC_DEV_LOGIN}`);

    let stopDaemon: (() => void) | undefined;
    let daemonExited: Promise<number | null> = Promise.resolve(null);
    let machineId: string | null = null;
    if (options.daemon !== false) {
        try {
            const paths = localDaemonPaths(home.dir);
            const main = await (options.daemonMain ?? loadDaemonMain)();
            const { credentials, paired } = await ensureLocalMachine({ node, credentialsFile: paths.credentialsFile, url: localPlatformUrl(port) });
            machineId = credentials.machineId;
            log(paired ? `[node] paired this machine as ${credentials.machineId} (${credentials.name})` : `[node] this machine: ${credentials.machineId}`);
            const until = new Promise<'signal'>((resolve) => (stopDaemon = () => resolve('signal')));
            daemonExited = main(['run'], { ...options.daemonContext, paths, until }).then(
                (code) => {
                    if (code !== 0) log(`[node] the local daemon exited with ${code}; the hub keeps running`);
                    return code;
                },
                (e: unknown) => {
                    log(`[node] the local daemon failed: ${e instanceof Error ? e.message : String(e)}; the hub keeps running`);
                    return 1;
                }
            );
        } catch (e) {
            // The hub is up either way: a machine can still pair the normal way.
            log(`[node] the local daemon did not start: ${e instanceof Error ? e.message : String(e)} (run with --no-daemon to skip it)`);
        }
    }

    if (options.open !== false) (options.opener ?? openBrowser)(claimLink ?? origin);

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
        (stopping ??= (async () => {
            if (stopDaemon) {
                stopDaemon();
                const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
                await Promise.race([daemonExited, new Promise((done) => setTimeout(done, DAEMON_STOP_TIMEOUT_MS).unref())]);
                // Its socket's close reaches the Machine actor (`socketClosed`) before the host drains, not after it stopped.
                const key = machineId ? machineKey(LOCAL_OWNER_ID, machineId) : undefined;
                while (key && node.daemonSockets.count(key) > 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
            }
            draining();
            try {
                await node.stop({ timeoutMs: STOP_TIMEOUT_MS });
            } catch (e) {
                log(`[node] the host did not stop cleanly: ${e instanceof Error ? e.message : String(e)}`);
            }
            // Not awaited: a browser's live socket would hold `close` open; the process exits after this.
            server.close();
            server.closeAllConnections();
            storage.close();
        })());

    return { node, server, origin, claimLink, machineId, daemonExited, stop };
}
