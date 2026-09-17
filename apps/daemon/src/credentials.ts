/**
 * The machine credentials `pair` stores (USR-04, EXE-10): the platform URL,
 * the workspace and machine ids and the machine token. The file is readable
 * by its owner only — `0600` on POSIX; on Windows inheritance is removed and
 * only the current user is granted access (`icacls`) BEFORE the token is
 * written, and a failure to restrict it aborts the write.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Credentials {
    readonly url: string;
    readonly workspaceId: string;
    readonly machineId: string;
    readonly token: string;
    readonly name: string;
    readonly pairedAt: number;
}

export interface CommandResult {
    readonly code: number | null;
    readonly stderr: string;
}

/** Runs a program without a shell. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            if (stderr.length < 8192) stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
    });

export interface SecureWriteOptions {
    readonly platform?: NodeJS.Platform;
    readonly run?: CommandRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The `icacls` arguments that leave `file` readable and writable by `user` alone. */
export function ownerOnlyAclArgs(file: string, user: string): string[] {
    return [file, '/inheritance:r', '/grant:r', `${user}:F`];
}

function windowsUser(env: Readonly<Record<string, string | undefined>>): string {
    const user = env.USERNAME;
    if (!user) throw new Error('[daemon] cannot restrict the credentials file: USERNAME is not set');
    return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

async function restrict(file: string, options: SecureWriteOptions): Promise<void> {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
        await chmod(file, 0o600);
        return;
    }
    const run = options.run ?? runCommand;
    const result = await run('icacls', ownerOnlyAclArgs(file, windowsUser(options.env ?? process.env)));
    if (result.code !== 0) throw new Error(`[daemon] icacls could not restrict ${file} (exit ${result.code}): ${result.stderr.trim()}`);
}

/** Write `contents` to `file` so that nobody but the owner can ever read it. */
export async function writeOwnerOnly(file: string, contents: string, options: SecureWriteOptions = {}): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        // Restrict the empty file first: the secret is never on disk with an inherited ACL.
        await writeFile(tmp, '', { mode: 0o600 });
        await restrict(tmp, options);
        await writeFile(tmp, contents, { mode: 0o600 });
        await rename(tmp, file);
    } catch (e) {
        await rm(tmp, { force: true });
        throw e;
    }
}

export async function saveCredentials(file: string, credentials: Credentials, options: SecureWriteOptions = {}): Promise<void> {
    await writeOwnerOnly(file, `${JSON.stringify(credentials, null, 2)}\n`, options);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The stored credentials, or `null` when the machine is not paired. Throws on a corrupt file. */
export async function loadCredentials(file: string): Promise<Credentials | null> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
    const value = JSON.parse(text) as Partial<Credentials>;
    if (!isText(value.url) || !isText(value.workspaceId) || !isText(value.machineId) || !isText(value.token)) {
        throw new Error(`[daemon] ${file} is not a valid credentials file — pair again`);
    }
    return { url: value.url, workspaceId: value.workspaceId, machineId: value.machineId, token: value.token, name: value.name ?? '', pairedAt: value.pairedAt ?? 0 };
}

/** The strings a logger must never print for these credentials. */
export function credentialSecrets(credentials: Pick<Credentials, 'token'> | null | undefined): string[] {
    if (!credentials) return [];
    const secret = credentials.token.split('.').pop() ?? '';
    return [credentials.token, secret];
}
