/**
 * The folder picker as the pages mount it (#193): `WorkdirDialog` (#191)
 * driven by a backend. Live, a listing is `Machine.fsRequest(env, list)`
 * then `fsResult(requestId)` read live until the daemon's `fs.response`
 * lands (#189); a worktree is the same round trip with `worktree`, and the
 * picker then opens the new folder. Recent folders are the Workspace's
 * (`recentWorkdirs`, #190). On mock data the folders are `mock/fs.ts`.
 *
 * The dialog is controlled: this component owns which environment and
 * folder are shown, keeps the last listing on screen while the next one
 * loads, and gives up on a machine that does not answer in time.
 */
import { component, effect, onUnmounted, signal, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { EnvironmentId, FsError, FsListResult, WorkdirRef } from '@agentic/core';
import { WorkdirDialog, type WorkdirEnvironment, type WorkdirRecent, type WorkdirWorktreeRequest } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';
import { dataMode } from '../../data-mode';
import { mockFsList, mockFsWorktree, mockRecentWorkdirs } from '../../mock/fs';
import { CLIENT_TIMEOUT_MS, requestError, startingPoint } from './model';

export type WorkdirPickerProps =
    & Define.Model<boolean>
    /** The folder chosen so far: the picker opens on it. */
    & Define.Prop<'value', WorkdirRef | null>
    & Define.Prop<'title', string>
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    /** The machine an environment belongs to — where its `fs.request` goes (live only). */
    & Define.Prop<'machineOf', (environmentId: string) => string | undefined>
    /** Open on this environment when the value names none (an agent's default environment). */
    & Define.Prop<'preferred', EnvironmentId | null>
    & Define.Event<'select', WorkdirRef>
    & Define.Event<'cancel'>;

interface PickerState {
    environmentId: EnvironmentId | null;
    path: string | null;
    /** The listing on screen: the last one that landed, kept while the next loads. */
    listing: FsListResult | null;
    loading: boolean;
    error: FsError | null;
    creating: boolean;
    worktreeError: FsError | null;
}

const closed = (): PickerState => ({ environmentId: null, path: null, listing: null, loading: false, error: null, creating: false, worktreeError: null });

/** What differs between the platform and the mock: how a listing and a worktree are asked for. */
interface Backend {
    list(environmentId: EnvironmentId, path: string): void;
    worktree(request: WorkdirWorktreeRequest): void;
    recent(): readonly WorkdirRecent[];
}

/** The dialog over one state and one backend; opening puts it on the value (or the preferred environment). */
function pickerView(props: WorkdirPickerProps, emit: (e: 'select' | 'cancel', v?: WorkdirRef) => void, st: PickerState, backend: Backend) {
    const navigate = (to: { environmentId: EnvironmentId; path: string | null }): void => {
        st.environmentId = to.environmentId;
        st.path = to.path;
        st.error = null;
        st.worktreeError = null;
        if (to.path === null) {
            st.listing = null;
            st.loading = false;
            return;
        }
        backend.list(to.environmentId, to.path);
    };
    const open = (): void => {
        Object.assign(st, closed());
        const start = startingPoint(props.value, props.environments, props.preferred ?? null);
        if (start.environmentId) navigate({ environmentId: start.environmentId, path: start.path });
    };
    let wasOpen = false;
    const stop = effect(() => {
        const isOpen = !!props.model?.value;
        if (isOpen && !wasOpen) open();
        wasOpen = isOpen;
    });
    onUnmounted(stop);

    return (): JSXElement => (
        <WorkdirDialog
            model={props.model}
            {...(props.title ? { title: props.title } : {})}
            environments={props.environments}
            recent={backend.recent()}
            environmentId={st.environmentId}
            path={st.path}
            listing={st.listing}
            loading={st.loading}
            error={st.error}
            creating={st.creating}
            worktreeError={st.worktreeError}
            onNavigate={navigate}
            onSelect={(ref: WorkdirRef) => emit('select', ref)}
            onCreateWorktree={(request: WorkdirWorktreeRequest) => {
                st.creating = true;
                st.worktreeError = null;
                backend.worktree(request);
            }}
            onCancel={() => emit('cancel')}
        />
    );
}

/** The platform: `fs.request` through the Machine actor, answers read live. */
const LiveWorkdirPicker = component<WorkdirPickerProps>(({ props, emit }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const st = signal<PickerState>(closed());
    const req = signal({ machine: '', list: '', worktree: '', environmentId: '' as EnvironmentId | '' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    onUnmounted(clearTimer);

    const machineKey = (): string | null => (viewer.workspaceId && req.machine ? machineKeyOf(viewer.workspaceId, req.machine) : null);
    const listing = useActorState(defs.Machine, () => { const k = machineKey(); return k && req.list ? ([k, 'fsResult', req.list] as const) : null; }, { live: true });
    const worktree = useActorState(defs.Machine, () => { const k = machineKey(); return k && req.worktree ? ([k, 'fsResult', req.worktree] as const) : null; }, { live: true });
    const recent = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'recentWorkdirs'] as const), { live: true });

    const machineFor = (environmentId: EnvironmentId): string | null => {
        const m = props.machineOf?.(environmentId);
        if (m) return m;
        st.loading = false;
        st.error = { code: 'unknown-environment', message: `No machine reports ${environmentId}` };
        return null;
    };

    // Only the newest request may install its id or its error: a quicker click must not be overwritten by a slower answer.
    let listSeq = 0;
    let worktreeSeq = 0;
    const backend: Backend = {
        list(environmentId, path) {
            const mine = ++listSeq;
            const ws = viewer.workspaceId;
            const machine = machineFor(environmentId);
            if (!ws || !machine) return;
            st.loading = true;
            clearTimer();
            void actor(defs.Machine, machineKeyOf(ws, machine))
                .fsRequest(environmentId, { kind: 'list', path })
                .then(({ requestId }) => {
                    if (mine !== listSeq) return;
                    Object.assign(req, { machine, list: requestId, environmentId });
                    timer = setTimeout(() => {
                        if (!st.loading) return;
                        st.loading = false;
                        st.error = { code: 'timeout', message: "The machine didn't answer" };
                    }, CLIENT_TIMEOUT_MS);
                })
                .catch((e: unknown) => {
                    if (mine !== listSeq) return;
                    st.loading = false;
                    st.error = requestError(e);
                });
        },
        worktree(request) {
            const mine = ++worktreeSeq;
            const ws = viewer.workspaceId;
            const machine = machineFor(request.environmentId);
            if (!ws || !machine) {
                st.creating = false;
                return;
            }
            const { environmentId, repo, branch, base, path } = request;
            void actor(defs.Machine, machineKeyOf(ws, machine))
                .fsRequest(environmentId, { kind: 'worktree', repo, branch, path, ...(base ? { base } : {}) })
                .then(({ requestId }) => { if (mine === worktreeSeq) Object.assign(req, { machine, worktree: requestId, environmentId }); })
                .catch((e: unknown) => {
                    if (mine !== worktreeSeq) return;
                    st.creating = false;
                    st.worktreeError = requestError(e);
                });
        },
        recent: () => recent.value ?? []
    };

    const view = pickerView(props, emit as never, st, backend);

    // A listing landed: show it, unless the user has moved on to another folder since.
    const stopList = effect(() => {
        const r = listing.value;
        if (!r || r.requestId !== req.list || r.status === 'pending') return;
        clearTimer();
        if (r.environmentId !== st.environmentId) return;
        st.loading = false;
        if (r.status === 'done' && r.result?.kind === 'list') {
            st.listing = r.result;
            st.path = r.result.path;
        } else st.error = r.error ?? { code: 'internal', message: 'The machine answered with something else' };
    });
    // A worktree landed: open it, so "Use this folder" is one click away.
    const stopWorktree = effect(() => {
        const r = worktree.value;
        if (!r || r.requestId !== req.worktree || r.status === 'pending') return;
        req.worktree = '';
        st.creating = false;
        if (r.status === 'done' && r.result?.kind === 'worktree') backend.list(r.environmentId, r.result.path);
        else st.worktreeError = r.error ?? { code: 'internal', message: 'The machine answered with something else' };
    });
    onUnmounted(() => { stopList(); stopWorktree(); });
    return view;
});

/** Mock data (`pnpm dev:mock`): the folders in `mock/fs.ts`, answered at once. */
const MockWorkdirPicker = component<WorkdirPickerProps>(({ props, emit }) => {
    const st = signal<PickerState>(closed());
    const answer = (environmentId: EnvironmentId, path: string): void => {
        const r = mockFsList(environmentId, path);
        st.loading = false;
        if ('code' in r) st.error = r;
        else {
            st.listing = r;
            st.path = r.path;
        }
    };
    const backend: Backend = {
        list: answer,
        worktree(request) {
            const r = mockFsWorktree(request.environmentId, request.repo, request.branch, request.path);
            st.creating = false;
            if ('code' in r) st.worktreeError = r;
            else answer(request.environmentId, r.path);
        },
        recent: () => mockRecentWorkdirs
    };
    return pickerView(props, emit as never, st, backend);
});

/** The picker on the data source the page reads. */
export const WorkdirPicker = component<WorkdirPickerProps>(({ props, emit }) => () => {
    const forward = {
        model: props.model,
        value: props.value ?? null,
        environments: props.environments,
        ...(props.title ? { title: props.title } : {}),
        ...(props.machineOf ? { machineOf: props.machineOf } : {}),
        preferred: props.preferred ?? null,
        onSelect: (ref: WorkdirRef) => emit('select', ref),
        onCancel: () => emit('cancel')
    };
    return dataMode() === 'live' ? <LiveWorkdirPicker {...forward} /> : <MockWorkdirPicker {...forward} />;
});
