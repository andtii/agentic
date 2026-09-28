/**
 * This machine as a runtime machine of its own node (#990): `agentic start`
 * runs the daemon in the same process and pairs it without a code.
 *
 *     <home>/daemon/credentials.json    the machine token (owner-only, `writeOwnerOnly`)
 *     <home>/daemon/environments.json   its environments (the web adds them: see below)
 *     <home>/daemon/policy.json         what the web may do on this machine
 *     <home>/daemon/sessions/           session logs
 *
 * Its own folder, apart from a standalone `agentic-daemon`'s (`%APPDATA%/agentic`,
 * `~/.config/agentic`): a daemon paired to another platform keeps its token.
 *
 * `ensureLocalMachine` mints the token the way `POST /auth/pair` does, minus
 * the typing: as the local owner, `Workspace.registerMachinePending` files a
 * code in the `PairingDirectory`, which resolves it, and `Machine.pair`
 * redeems it. The preset is the Pair page's default (`['~']`), so the owner
 * adds environments under the home folder from the web. Stored credentials
 * are kept while the Machine actor still accepts their token; a revoked or
 * unknown one is replaced by a fresh pairing.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MachineId, WorkspaceId } from '@agentic/core';
import { asPrincipal, LOCAL_OWNER_ID, machineKey, userPrincipal, type MachineOs, type WorkspaceActor } from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { loadCredentials, saveCredentials, type Credentials } from '../../daemon/src/credentials';
import type { DaemonPaths } from '../../daemon/src/paths';
import { workspaceKeyOf } from '../../web/src/actors/keys';
import { verifyDaemonToken } from '../../web/src/daemon';
import { runWithHost } from '../../web/src/host-scope';
import { machineDefinition, pairingWiring } from '../../web/src/platform.app';
import type { NodeHost } from './host';

/** The in-process daemon's folders: all of them under `<home>/daemon`. */
export function localDaemonPaths(homeDir: string): DaemonPaths {
    const dir = join(homeDir, 'daemon');
    return {
        configDir: dir,
        credentialsFile: join(dir, 'credentials.json'),
        environmentsFile: join(dir, 'environments.json'),
        policyFile: join(dir, 'policy.json'),
        stateDir: dir,
        sessionsDir: join(dir, 'sessions'),
        logFile: join(dir, 'logs', 'daemon.log')
    };
}

/** The daemon's URL for a node on `port`: the loopback, whatever `APP_ORIGIN` says (a LAN name or a proxy may not loop back). */
export const localPlatformUrl = (port: number): string => `http://127.0.0.1:${port}`;

export const machineOsOf = (platform: NodeJS.Platform): MachineOs | undefined => (platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined);

export interface EnsureLocalMachineOptions {
    readonly node: Pick<NodeHost, 'host' | 'actors'>;
    readonly credentialsFile: string;
    /** `localPlatformUrl(port)`. */
    readonly url: string;
    /** Default `os.hostname()`. */
    readonly name?: string;
    readonly platform?: NodeJS.Platform;
    readonly daemonVersion?: string;
    /** The folders the web may use once it pairs. Default `['~']`. */
    readonly allowedRoots?: readonly string[];
    /** `saveCredentials`' ACL options (tests). */
    readonly secure?: Parameters<typeof saveCredentials>[2];
}

export interface LocalMachine {
    readonly credentials: Credentials;
    /** `true` when this call paired the machine; `false` when stored credentials were kept. */
    readonly paired: boolean;
}

/** The local owner's machine credentials: the stored ones while their token still works, else a fresh pairing (saved). */
export async function ensureLocalMachine(options: EnsureLocalMachineOptions): Promise<LocalMachine> {
    const { node, credentialsFile, url } = options;
    const Machine = machineDefinition(node.actors);
    const stored = await loadCredentials(credentialsFile).catch(() => null);
    if (stored && stored.workspaceId === LOCAL_OWNER_ID) {
        const who = { workspaceId: stored.workspaceId as WorkspaceId, machineId: stored.machineId as MachineId, key: machineKey(stored.workspaceId, stored.machineId), token: stored.token };
        const refused = await runWithHost(node.host, () => verifyDaemonToken(who, node.host, Machine));
        if (!refused) {
            // The port may have changed since: the token is the proof, the URL only where to dial.
            if (stored.url === url) return { credentials: stored, paired: false };
            const moved = { ...stored, url };
            await saveCredentials(credentialsFile, moved, options.secure);
            return { credentials: moved, paired: false };
        }
    }

    const name = options.name ?? hostname();
    const os = machineOsOf(options.platform ?? process.platform);
    const Workspace = node.actors.find((d) => (d as { type: string }).type === 'Workspace') as WorkspaceActor | undefined;
    if (!Workspace) throw new Error('[node] no `Workspace` actor in the registry');
    const owner = asPrincipal(userPrincipal(LOCAL_OWNER_ID, LOCAL_OWNER_ID as WorkspaceId));
    const pairing = pairingWiring(node.actors as readonly AnyActorDefinition[]);
    const issued = await runWithHost(node.host, async () => {
        const { pairingCode } = await node.host
            .actor(Workspace, workspaceKeyOf(LOCAL_OWNER_ID))
            .with({ context: owner })
            .registerMachinePending({ name, allowedRoots: options.allowedRoots ?? ['~'] });
        const target = await pairing.resolve(pairingCode);
        if (!target) throw new Error('[node] the pairing directory did not resolve the code it was just given');
        return pairing.pair(target, pairingCode, { name, ...(os ? { os } : {}), ...(options.daemonVersion ? { daemonVersion: options.daemonVersion } : {}) });
    });
    const credentials: Credentials = { url, token: issued.token, workspaceId: issued.workspaceId, machineId: issued.machineId, name, pairedAt: Date.now() };
    await saveCredentials(credentialsFile, credentials, options.secure);
    return { credentials, paired: true };
}
