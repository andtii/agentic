/**
 * A file ref's pinned lines, read live (#939): the hover card asks the daemon for `fs read-at` — the lines as committed
 * at the ref's sha — on a machine that holds the project: the one the item's task runs on, else the first online
 * machine with a project folder. An offline machine, no folder, or a refusal is said on the card instead of lines.
 * On mock data the fixtures' `PlanDoc.pins` answer instead.
 */
import { signal } from 'sigx';
import { actor } from '@sigx/actors';
import { formatRef, projectFolderFor, type EnvironmentId, type FsError, type FsOp, type FsResult, type MachineId, type ProjectRecord, type Ref } from '@agentic/core';
import { useActorDefs, useViewer, type ActorDefs } from '../../../../../actors/defs';
import { machineKeyOf } from '../../../../../actors/keys';
import { useEnvironmentDirectory, type EnvironmentEntry } from '../../../../ops/environments';
import { CLIENT_TIMEOUT_MS, requestError } from '../../../../workdir/model';
import type { PlanItemRun } from './model';

type FileRef = Extract<Ref, { kind: 'file' }>;

/** Where a pinned file is read: a machine's environment and the folder the ref's path is relative to. */
export interface PinPlace {
    readonly machineId: string;
    readonly machineName: string;
    readonly environmentId: string;
    readonly root: string;
    readonly online: boolean;
}

/** An environment as the place picker sees it. */
export type PinEnvironment = Pick<EnvironmentEntry, 'id' | 'machineId' | 'machineName' | 'online'>;

/**
 * Where to read a file ref's lines: the item's task's folder when it runs somewhere known, else the project's folder
 * on the first online environment that has one, else the first offline one (the card then says it is offline).
 * `undefined` when no machine holds the project.
 */
export function pinPlaceOf(project: Pick<ProjectRecord, 'folders'>, environments: readonly PinEnvironment[], run?: PlanItemRun): PinPlace | undefined {
    if (run?.machineId && run.environmentId && run.workdir) {
        const env = environments.find((e) => e.machineId === run.machineId && e.id === run.environmentId);
        return { machineId: run.machineId, machineName: env?.machineName ?? run.machineId, environmentId: run.environmentId, root: run.workdir, online: env?.online ?? false };
    }
    let offline: PinPlace | undefined;
    for (const env of environments) {
        const root = projectFolderFor(project, env.id as EnvironmentId, env.machineId as MachineId);
        if (!root) continue;
        const place = { machineId: env.machineId, machineName: env.machineName, environmentId: env.id, root, online: env.online };
        if (env.online) return place;
        offline ??= place;
    }
    return offline;
}

/** What the hover card shows for a pinned ref. */
export type PinView =
    | { readonly status: 'loading' }
    | { readonly status: 'done'; readonly lines: readonly string[]; readonly branch?: string }
    /** The machine that holds the project is offline. */
    | { readonly status: 'offline'; readonly machine: string }
    /** No machine holds the project's folder. */
    | { readonly status: 'nowhere' }
    | { readonly status: 'error'; readonly message: string };

/** One fs request on a machine's environment: the daemon's answer, or its error. */
export type PinFs = (machineId: string, environmentId: string, op: FsOp) => Promise<FsResult | FsError>;

/** The pinned lines the hover card reads: `open` starts the read (once per ref and place), `view` is its state. */
export interface PinSource {
    open(ref: FileRef, run?: PlanItemRun): void;
    view(ref: FileRef, run?: PlanItemRun): PinView | undefined;
}

const isError = (r: FsResult | FsError): r is FsError => 'code' in r && !('kind' in r);

/** A pin source over a place picker and an fs — live over the Machine actor, in tests a fake. */
export function createPinSource(place: (run?: PlanItemRun) => PinPlace | undefined, fs: PinFs, ready: () => boolean = () => true): PinSource {
    const st = signal({ views: {} as Record<string, PinView> });
    const keyOf = (ref: FileRef, p: PinPlace | undefined): string => `${formatRef(ref)}@${p ? `${p.machineId}/${p.environmentId}:${p.root}` : ''}`;
    const set = (key: string, view: PinView): void => { st.views = { ...st.views, [key]: view }; };
    const stateless = (p: PinPlace | undefined): PinView | undefined => (!p ? { status: 'nowhere' } : !p.online ? { status: 'offline', machine: p.machineName } : undefined);
    const source: PinSource = {
        open(ref, run) {
            if (!ref.sha || !ready()) return;
            const p = place(run);
            const key = keyOf(ref, p);
            if (!p || !p.online) return;
            const known = st.views[key];
            if (known && known.status !== 'error') return;
            set(key, { status: 'loading' });
            fs(p.machineId, p.environmentId, { kind: 'read-at', root: p.root, path: ref.path, sha: ref.sha, from: ref.from, to: ref.to }).then(
                (r) => {
                    if (isError(r)) set(key, { status: 'error', message: r.message });
                    else if (r.kind === 'read-at' || r.kind === 'pin') set(key, { status: 'done', lines: r.lines, ...(run?.branch ? { branch: run.branch } : {}) });
                    else set(key, { status: 'error', message: 'The machine answered with something else' });
                },
                (e: unknown) => set(key, { status: 'error', message: requestError(e).message })
            );
        },
        view(ref, run) {
            if (!ref.sha) return undefined;
            if (!ready()) return { status: 'loading' };
            const p = place(run);
            const known = stateless(p) ?? st.views[keyOf(ref, p)];
            if (known) return known;
            // Open before the machines were known: start the read now, outside the render.
            queueMicrotask(() => source.open(ref, run));
            return { status: 'loading' };
        }
    };
    return source;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The Machine actor as a `PinFs`: `fsRequest`, then `fsResult` polled until the daemon answers or the client deadline passes. */
export function machinePinFs(defs: Pick<ActorDefs, 'Machine'>, workspaceId: () => string | null, pollMs = 250): PinFs {
    return async (machineId, environmentId, op) => {
        const ws = workspaceId();
        if (!ws) return { code: 'internal', message: 'Not signed in' };
        const machine = actor(defs.Machine, machineKeyOf(ws, machineId));
        const { requestId } = await machine.fsRequest(environmentId as EnvironmentId, op);
        const deadline = Date.now() + CLIENT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const r = await machine.fsResult(requestId);
            if (r && r.status !== 'pending') return r.error ?? r.result ?? { code: 'internal', message: 'The machine answered with nothing' };
            await sleep(pollMs);
        }
        return { code: 'timeout', message: "The machine didn't answer" };
    };
}

/** The live pin source for a project's Plan list. Call in setup. */
export function useLivePins(project: () => Pick<ProjectRecord, 'folders'>): PinSource {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useEnvironmentDirectory(defs, viewer);
    return createPinSource((run) => pinPlaceOf(project(), directory.all(), run), machinePinFs(defs, () => viewer.workspaceId), () => !directory.loading);
}
