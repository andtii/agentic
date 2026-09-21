/**
 * Where the daemon keeps things (architecture §5b). The token,
 * `environments.json` and `policy.json` are configuration and roam with the user profile
 * (`%APPDATA%/agentic`); session logs are machine-local state
 * (`%LOCALAPPDATA%/agentic/sessions`). `AGENTIC_DAEMON_HOME` puts both under
 * one directory — for tests and portable installs.
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface DaemonPaths {
    readonly configDir: string;
    readonly credentialsFile: string;
    readonly environmentsFile: string;
    /** The machine-local policy for web-managed environments (#238); only ever edited on this machine. */
    readonly policyFile: string;
    readonly stateDir: string;
    readonly sessionsDir: string;
}

export interface PathContext {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly home?: string;
}

export function daemonPaths(context: PathContext = {}): DaemonPaths {
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    const home = context.home ?? homedir();
    const { join } = platform === 'win32' ? win32 : posix;

    let configDir: string;
    let stateDir: string;
    if (env.AGENTIC_DAEMON_HOME) {
        configDir = env.AGENTIC_DAEMON_HOME;
        stateDir = env.AGENTIC_DAEMON_HOME;
    } else if (platform === 'win32') {
        configDir = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'agentic');
        stateDir = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'agentic');
    } else if (platform === 'darwin') {
        configDir = join(home, 'Library', 'Application Support', 'agentic');
        stateDir = configDir;
    } else {
        configDir = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'agentic');
        stateDir = join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'agentic');
    }
    return {
        configDir,
        credentialsFile: join(configDir, 'credentials.json'),
        environmentsFile: join(configDir, 'environments.json'),
        policyFile: join(configDir, 'policy.json'),
        stateDir,
        sessionsDir: join(stateDir, 'sessions')
    };
}

/**
 * Where the installers put the daemon (#343, #362): the install root holds `daemon/` (the unpacked zip),
 * `node/` (a downloaded portable Node), `bin/` (the `agentic-daemon` command), `supervisor/` (the relaunch
 * loop the service runs, `scripts/supervise.mjs`) and `state/` — what the supervisor and the daemon tell each
 * other: `ready` (the daemon is welcomed), `supervisor.json` (restarts, the last exit), `update-failed.json`
 * (a rolled-back update) and `supervisor.log`. `%LOCALAPPDATA%\agentic` on Windows, `~/.agentic` elsewhere;
 * `AGENTIC_INSTALL_DIR` overrides it (the supervisor sets it for the daemon it runs).
 */
export interface InstallPaths {
    readonly root: string;
    readonly daemonDir: string;
    readonly supervisorScript: string;
    readonly stateDir: string;
    readonly readyFile: string;
    readonly supervisorFile: string;
    readonly updateFailedFile: string;
    readonly supervisorLog: string;
}

export function installPaths(context: PathContext = {}): InstallPaths {
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    const home = context.home ?? homedir();
    const { join } = platform === 'win32' ? win32 : posix;
    const root = env.AGENTIC_INSTALL_DIR || (platform === 'win32' ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'agentic') : join(home, '.agentic'));
    const stateDir = join(root, 'state');
    return {
        root,
        daemonDir: join(root, 'daemon'),
        supervisorScript: join(root, 'supervisor', 'supervise.mjs'),
        stateDir,
        readyFile: join(stateDir, 'ready'),
        supervisorFile: join(stateDir, 'supervisor.json'),
        updateFailedFile: join(stateDir, 'update-failed.json'),
        supervisorLog: join(stateDir, 'supervisor.log')
    };
}
