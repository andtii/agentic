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
