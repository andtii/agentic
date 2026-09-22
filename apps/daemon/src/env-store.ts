/**
 * Editing `environments.json` without a text editor (#235): the pure
 * add / remove over `LocalEnvironment[]`, the atomic owner-only writer, and
 * the watcher that hands a changed file to a running daemon. The CLI's
 * `env add | list | rm` are thin over these, and so is whatever answers an
 * `env.request` later (#238) — nothing here prints or exits.
 *
 * A `profileDir` is allocated at `<configDir>/profiles/<id>` unless one is
 * given, and two environments never share one: that is the account isolation
 * (EXE-04/05), so it is refused here rather than found by `doctor` afterwards.
 */

import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writeOwnerOnly, type SecureWriteOptions } from './credentials.js';
import { loadEnvironments, parseEnvironments, type EnvironmentsResult } from './environments.js';
import type { DaemonPaths } from './paths.js';

export type EnvironmentStoreErrorCode = 'invalid' | 'exists' | 'not-found' | 'shared-profile-dir';

export class EnvironmentStoreError extends Error {
    override readonly name = 'EnvironmentStoreError';
    constructor(
        readonly code: EnvironmentStoreErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** What `env add` (and later an `env.request put`) supplies; everything else is derived. */
export interface EnvironmentInput {
    /** Default `env_<slug of name>`, made unique. */
    readonly id?: string;
    readonly name: string;
    readonly runtime: string;
    readonly cwdRoots: readonly string[];
    readonly concurrency?: number;
    readonly accountLabel?: string;
    /** Default `<configDir>/profiles/<id>`. Never taken from the platform. */
    readonly profileDir?: string;
    /** `true` sets, `false` clears, absent keeps what the environment has (#450, #355). */
    readonly allowBypassPermissions?: boolean;
}

export interface PutOptions {
    /** Replace the environment with the same id (its `profileDir` is kept unless one is given). Default: an existing id is refused. */
    readonly replace?: boolean;
    readonly platform?: NodeJS.Platform;
}

/** Where an environment's runtime profile lives when none is named. */
export function profileDirFor(paths: Pick<DaemonPaths, 'configDir'>, id: string): string {
    return join(paths.configDir, 'profiles', id);
}

/** `env_<slug>`; `env_<slug>_2`, … when taken. */
export function newEnvironmentId(name: string, taken: ReadonlySet<string>): EnvironmentId {
    const slug =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48) || 'environment';
    let id = `env_${slug}`;
    for (let n = 2; taken.has(id); n++) id = `env_${slug}_${n}`;
    return id as EnvironmentId;
}

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => {
    const [x, y] = [resolve(a), resolve(b)];
    return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** `current` with `input` added (or replaced). Pure; throws `EnvironmentStoreError`. */
export function addEnvironment(current: readonly LocalEnvironment[], input: EnvironmentInput, paths: Pick<DaemonPaths, 'configDir'>, options: PutOptions = {}): { readonly environments: LocalEnvironment[]; readonly environment: LocalEnvironment } {
    const platform = options.platform ?? process.platform;
    const existing = input.id === undefined ? undefined : current.find((e) => e.id === input.id);
    if (existing && !options.replace) throw new EnvironmentStoreError('exists', `environment "${input.id}" already exists`);
    const id = input.id ?? newEnvironmentId(input.name ?? '', new Set(current.map((e) => e.id)));
    for (const root of input.cwdRoots ?? []) if (typeof root === 'string' && !isAbsolute(root)) throw new EnvironmentStoreError('invalid', `working root "${root}" must be an absolute path`);
    // A replaced environment keeps its profile — also when that is the runtime's default one (a hand-written row without `profileDir`):
    // allocating a directory there would sign the environment out.
    const profileDir = input.profileDir ?? (existing ? existing.profileDir : profileDirFor(paths, id));
    if (profileDir !== undefined && !isAbsolute(profileDir)) throw new EnvironmentStoreError('invalid', `profile dir "${profileDir}" must be an absolute path`);
    const row = {
        id,
        name: input.name,
        runtime: input.runtime,
        ...(profileDir === undefined ? {} : { profileDir }),
        cwdRoots: [...(input.cwdRoots ?? [])],
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
        // Kept across a replace unless the input says otherwise (#453; settable from the web since #355 — the platform admits that only to an elevated owner).
        ...((input.allowBypassPermissions ?? existing?.allowBypassPermissions) ? { allowBypassPermissions: true } : {})
    };
    const others = current.filter((e) => e.id !== id);
    const sharing = profileDir === undefined ? undefined : others.find((e) => e.profileDir !== undefined && samePath(e.profileDir, profileDir, platform));
    if (sharing) throw new EnvironmentStoreError('shared-profile-dir', `profile dir ${profileDir} is already used by environment "${sharing.id}" — two environments never share an account profile`);
    // The file's own validator has the last word, so what is written always loads.
    const checked = parseEnvironments([row]);
    if (!checked.ok) throw new EnvironmentStoreError('invalid', checked.errors.map((e) => e.replace(/^environments\[0\]\./, '')).join('; '));
    const environment = checked.environments[0]!;
    const environments = existing ? current.map((e) => (e.id === id ? environment : e)) : [...current, environment];
    return { environments, environment };
}

/** `current` without `id`. Pure; throws `not-found`. The profile directory stays on disk — it holds a sign-in. */
export function removeEnvironment(current: readonly LocalEnvironment[], id: string): { readonly environments: LocalEnvironment[]; readonly removed: LocalEnvironment } {
    const removed = current.find((e) => e.id === id);
    if (!removed) throw new EnvironmentStoreError('not-found', `no environment "${id}"`);
    return { environments: current.filter((e) => e.id !== id), removed };
}

/** Atomic (temp + rename) and owner-only, like `credentials.json`: a reader — the watcher included — never sees half a file. */
export async function writeEnvironments(file: string, environments: readonly LocalEnvironment[], options: SecureWriteOptions = {}): Promise<void> {
    await writeOwnerOnly(file, `${JSON.stringify({ environments }, null, 2)}\n`, options);
}

/** The environments on disk, for an edit: an invalid file is never overwritten. */
export async function readEnvironmentsForEdit(file: string): Promise<readonly LocalEnvironment[]> {
    const loaded = await loadEnvironments(file);
    if (!loaded.ok) throw new EnvironmentStoreError('invalid', `${file} is invalid — fix it first:\n  ${loaded.errors.join('\n  ')}`);
    return loaded.environments;
}

/** Read → add → create the profile directory → write. */
export async function putEnvironment(paths: Pick<DaemonPaths, 'configDir' | 'environmentsFile'>, input: EnvironmentInput, options: PutOptions & SecureWriteOptions = {}): Promise<LocalEnvironment> {
    const current = await readEnvironmentsForEdit(paths.environmentsFile);
    const { environments, environment } = addEnvironment(current, input, paths, options);
    if (environment.profileDir !== undefined) await mkdir(environment.profileDir, { recursive: true });
    await writeEnvironments(paths.environmentsFile, environments, options);
    return environment;
}

/** Read → remove → write. */
export async function deleteEnvironment(paths: Pick<DaemonPaths, 'environmentsFile'>, id: string, options: SecureWriteOptions = {}): Promise<LocalEnvironment> {
    const { environments, removed } = removeEnvironment(await readEnvironmentsForEdit(paths.environmentsFile), id);
    await writeEnvironments(paths.environmentsFile, environments, options);
    return removed;
}

export interface WatchConfigFileOptions<T> {
    readonly file: string;
    /** Reads the file once its events have settled. */
    load(file: string): Promise<T>;
    /** Every settled change, valid or not; the caller keeps what it runs with when the result says the file is bad. */
    onChange(result: T): void | Promise<void>;
    onError?(error: unknown): void;
    /** Default 250 ms. */
    readonly debounceMs?: number;
    /** Default `fs.watch`. */
    readonly watch?: (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => Pick<FSWatcher, 'close' | 'on'>;
}

export type WatchEnvironmentsOptions = Omit<WatchConfigFileOptions<EnvironmentsResult>, 'load'>;

/** `environments.json`, re-read whenever it changes. */
export function watchEnvironments(options: WatchEnvironmentsOptions): Promise<{ close(): void }> {
    return watchConfigFile({ ...options, load: loadEnvironments });
}

/**
 * Watch the DIRECTORY, not the file: an atomic write replaces the file, and a
 * watch on the old inode goes quiet. Events are debounced and the file is
 * re-read once they settle. `policy.json` is watched the same way (#238).
 */
export async function watchConfigFile<T>(options: WatchConfigFileOptions<T>): Promise<{ close(): void }> {
    const dir = dirname(options.file);
    const name = basename(options.file);
    await mkdir(dir, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const settle = (): void => {
        timer = undefined;
        if (closed) return;
        void options
            .load(options.file)
            .then((result) => (closed ? undefined : options.onChange(result)))
            .catch((e: unknown) => options.onError?.(e));
    };
    const watcher = (options.watch ?? ((d, listener) => watch(d, { persistent: false }, listener)))(dir, (_event, filename) => {
        // Some platforms give no filename: re-read then too.
        if (filename !== null && filename.toString() !== name) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(settle, options.debounceMs ?? 250);
        timer.unref?.();
    });
    watcher.on('error', (e: unknown) => options.onError?.(e));
    return {
        close() {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
            watcher.close();
        }
    };
}
