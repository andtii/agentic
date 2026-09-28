/**
 * The `agentic` command (#990):
 *
 *     agentic start [--port <n>] [--no-daemon] [--no-open]   the platform, with this machine paired (`start.ts`)
 *     agentic status [--port <n>]                              the data dir, the owner, the server, this machine
 *     agentic export|import …                                  a Cloudflare deployment → this node (`import/cli.ts`)
 *     agentic --help
 *
 * No command at all is `start` (`node dist/main.js`, as before).
 */
import { existsSync } from 'node:fs';
import { loadCredentials } from '../../daemon/src/credentials';
import { openHome, type NodeHome, type OpenHomeOptions } from './home';
import { fileLocalOwnerStore } from './local-owner';
import { localDaemonPaths } from './local-machine';

export const USAGE = `agentic — the agentic platform on this machine

Usage:
  agentic start [--port <n>] [--no-daemon] [--no-open]
                  serve the platform (default port 8787, data in $AGENTIC_HOME or ~/.agentic),
                  run this machine's daemon in the same process, paired to the local owner
                  (--no-daemon: the hub only), and open the browser (--no-open: print the link only)
  agentic status [--port <n>]
                  the data folder, whether the node is claimed and serving, this machine's pairing
  agentic export <dump.ndjson> [--no-files | --files <dir>]
  agentic import <dump.ndjson>
                  move a Cloudflare deployment's state to this node (the node stopped)
  agentic --help
`;

export type CliCommand =
    | { readonly kind: 'start'; readonly port?: number; readonly daemon: boolean; readonly open: boolean }
    | { readonly kind: 'status'; readonly port?: number }
    | { readonly kind: 'help' }
    | { readonly kind: 'import'; readonly argv: readonly string[] }
    | { readonly kind: 'error'; readonly message: string };

/** `argv` without node and the script. */
export function parseCli(argv: readonly string[]): CliCommand {
    const [command, ...rest] = argv;
    if (command === 'export' || command === 'import') return { kind: 'import', argv };
    if (command === 'help' || command === '--help' || command === '-h') return { kind: 'help' };
    if (command !== undefined && command !== 'start' && command !== 'status' && !command.startsWith('-')) return { kind: 'error', message: `unknown command: ${command}` };
    const status = command === 'status';
    const flags = command === 'start' || status ? rest : argv;
    let daemon = true;
    let open = true;
    let port: number | undefined;
    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i]!;
        if (flag === '--no-daemon' && !status) daemon = false;
        else if (flag === '--no-open' && !status) open = false;
        else if (flag === '--help' || flag === '-h') return { kind: 'help' };
        else if (flag === '--port' || flag.startsWith('--port=')) {
            const value = flag === '--port' ? flags[++i] : flag.slice('--port='.length);
            const n = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
            if (!Number.isInteger(n) || n < 1 || n > 65_535) return { kind: 'error', message: '--port takes a port number (1-65535)' };
            port = n;
        } else return { kind: 'error', message: `unknown option: ${flag}` };
    }
    const at = port === undefined ? {} : { port };
    return status ? { kind: 'status', ...at } : { kind: 'start', daemon, open, ...at };
}

/** `openHome` with `--port` over `PORT`. */
export function openHomeFor(command: { readonly port?: number }, options: OpenHomeOptions = {}): NodeHome {
    const processEnv = options.processEnv ?? process.env;
    return openHome({ ...options, processEnv: command.port === undefined ? processEnv : { ...processEnv, PORT: String(command.port) } });
}

export interface StatusOptions {
    readonly home: NodeHome;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
}

/** What `agentic status` prints, one line each. Never throws for a node that is down or unclaimed. */
export async function statusLines(options: StatusOptions): Promise<string[]> {
    const { home } = options;
    const origin = home.env.APP_ORIGIN!;
    const lines = [`data:     ${home.dir}`, `url:      ${origin}`];
    const record = fileLocalOwnerStore(home.dir).load();
    lines.push(`owner:    ${record.owner ? 'claimed' : existsSync(home.database) ? 'not claimed — `agentic start` prints the claim link' : 'not claimed (never started)'}`);
    const f = options.fetch ?? fetch;
    let serving: string;
    try {
        const response = await f(`http://127.0.0.1:${home.port}/auth/me`, { signal: AbortSignal.timeout(options.timeoutMs ?? 2_000) });
        serving = `running on port ${home.port} (HTTP ${response.status})`;
    } catch {
        serving = `not running on port ${home.port}`;
    }
    lines.push(`server:   ${serving}`);
    const paths = localDaemonPaths(home.dir);
    const credentials = await loadCredentials(paths.credentialsFile).catch(() => null);
    lines.push(`machine:  ${credentials ? `${credentials.machineId} (${credentials.name || 'unnamed'}), paired to the local owner` : 'not paired — `agentic start` pairs it'}`);
    return lines;
}
