/**
 * The project form's Find (#333): `Machine.fsRequest(env, { kind: 'locate',
 * origin })`, then `fsResult(requestId)` read live until the daemon's
 * answer lands — the same round trip as a folder listing (`WorkdirPicker`,
 * #189), with the same client deadline. On mock data the answer is
 * `mockFsLocate`, at once. The form reads `state` and calls `start`; one
 * request at a time, the newest wins.
 */
import { effect, onUnmounted, signal } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { EnvironmentId, FsError, FsGitInfo } from '@agentic/core';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { machineKeyOf } from '../../actors/keys';
import { mockFsLocate } from '../../mock/fs';
import { CLIENT_TIMEOUT_MS, requestError } from '../workdir/model';

export interface LocateMatch {
    readonly path: string;
    readonly git: FsGitInfo;
}

export interface LocateState {
    /** The environment being searched; `null` while idle. */
    environmentId: EnvironmentId | null;
    origin: string;
    status: 'idle' | 'loading' | 'done' | 'error';
    matches: readonly LocateMatch[];
    truncated: boolean;
    error: FsError | null;
}

export interface LocateBackend {
    readonly state: LocateState;
    /** `machineId` names where the environment is (#702: its id is only unique there); else the directory's first machine reporting it. */
    start(environmentId: EnvironmentId, origin: string, machineId?: string): void;
    reset(): void;
}

const idle = (): LocateState => ({ environmentId: null, origin: '', status: 'idle', matches: [], truncated: false, error: null });

/** Mock data: the trees in `mock/fs.ts`, answered synchronously. */
export function mockLocate(): LocateBackend {
    const state = signal<LocateState>(idle());
    return {
        state,
        start(environmentId, origin) {
            const r = mockFsLocate(environmentId, origin);
            Object.assign(state, idle(), { environmentId, origin });
            if ('code' in r) Object.assign(state, { status: 'error', error: r });
            else Object.assign(state, { status: 'done', matches: r.matches, truncated: r.truncated });
        },
        reset() {
            Object.assign(state, idle());
        }
    };
}

/** The platform: the request through the Machine actor, the answer read live, a deadline like the picker's. */
export function useLiveLocate(defs: Pick<ActorDefs, 'Machine'>, viewer: Pick<ViewerState, 'workspaceId'>, machineOf: (environmentId: string) => string | undefined): LocateBackend {
    const state = signal<LocateState>(idle());
    const req = signal({ machine: '', id: '' });
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    const result = useActorState(defs.Machine, () => (viewer.workspaceId && req.machine && req.id ? ([machineKeyOf(viewer.workspaceId, req.machine), 'fsResult', req.id] as const) : null), { live: true });
    // The answer landed — for the request still on screen, and only once.
    const stop = effect(() => {
        const r = result.value;
        if (!r || r.requestId !== req.id || r.status === 'pending' || state.status !== 'loading') return;
        clearTimer();
        if (r.status === 'done' && r.result?.kind === 'locate') Object.assign(state, { status: 'done', matches: r.result.matches, truncated: r.result.truncated });
        else Object.assign(state, { status: 'error', error: r.error ?? { code: 'internal', message: 'The machine answered with something else' } });
    });
    onUnmounted(() => {
        clearTimer();
        stop();
    });
    return {
        state,
        start(environmentId, origin, machineId) {
            const mine = ++seq;
            const ws = viewer.workspaceId;
            const machine = machineId ?? machineOf(environmentId);
            clearTimer();
            Object.assign(req, { machine: '', id: '' });
            Object.assign(state, idle(), { environmentId, origin, status: 'loading' });
            if (!ws) return;
            if (!machine) {
                Object.assign(state, { status: 'error', error: { code: 'unknown-environment', message: `No machine reports ${environmentId}` } });
                return;
            }
            void actor(defs.Machine, machineKeyOf(ws, machine))
                .fsRequest(environmentId, { kind: 'locate', origin })
                .then(({ requestId }) => {
                    if (mine !== seq) return;
                    Object.assign(req, { machine, id: requestId });
                    timer = setTimeout(() => {
                        if (mine !== seq || state.status !== 'loading') return;
                        Object.assign(state, { status: 'error', error: { code: 'timeout', message: "The machine didn't answer" } });
                    }, CLIENT_TIMEOUT_MS);
                })
                .catch((e: unknown) => {
                    if (mine !== seq) return;
                    Object.assign(state, { status: 'error', error: requestError(e) });
                });
        },
        reset() {
            seq++;
            clearTimer();
            Object.assign(req, { machine: '', id: '' });
            Object.assign(state, idle());
        }
    };
}
