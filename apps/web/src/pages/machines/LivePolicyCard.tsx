/**
 * The folders card on the platform (#482): `Machine.get()`'s `policy`
 * (as the daemon reports it) and `policyDesired` (as the owner wants it),
 * the list as edited, **Save** → `setPolicy` through the page's elevation
 * helper and the daemon's answer read live with `policyResult` — the
 * round trip the environment dialog makes — and **Browse…** →
 * `browseMachine` the same way, a listing at a time. Both are elevated
 * calls: refused `elevation-required`, the helper opens "Confirm with
 * GitHub" and the list (and the folder being browsed) survives the round
 * trip as the pending change; `resume` is the page handing it back.
 */
import { component, effect, onUnmounted, signal, untrack, watch, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { HostOs, MachineListing } from '@agentic/core';
import type { MachineView } from '@agentic/platform';
import { useActorDefs } from '../../actors/defs';
import { CLIENT_TIMEOUT_MS } from '../workdir/model';
import { BrowseDialog } from './BrowseDialog';
import { isElevationRequired } from './elevate';
import { PolicyCard } from './PolicyCard';
import { policyAnswerFailure, policyCallFailure, policyCardState, policyFailureText, policyRootsOf, sameRoots } from './policy';

/** The change put aside for the elevation round trip: the list, and the folder being browsed when Browse… asked. */
export interface PolicyPending {
    readonly allowedRoots: readonly string[];
    /** Present when it was Browse… that needed elevation: reopen the browser there (`null` = the roots). */
    readonly browse?: string | null;
}

export const isPolicyPending = (v: unknown): v is PolicyPending => !!v && typeof v === 'object' && Array.isArray((v as PolicyPending).allowedRoots) && (v as PolicyPending).allowedRoots.every((r) => typeof r === 'string');

export type LivePolicyCardProps =
    & Define.Prop<'machineKey', string, true>
    & Define.Prop<'view', MachineView, true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    & Define.Prop<'timeZone', string>
    /** The first folder the machine's environments work in, for the no-feature well. */
    & Define.Prop<'likelyRoot', string>
    /** Run an elevated change: the page's `withElevation('policy', …)`. */
    & Define.Prop<'elevate', (run: () => Promise<unknown>, draft: PolicyPending) => Promise<void>, true>
    /** Back from GitHub: the page hands the change over; a new object each time. */
    & Define.Prop<'resume', PolicyPending | null>;

export const LivePolicyCard = component<LivePolicyCardProps>(({ props }) => {
    const defs = useActorDefs();
    const client = () => actor(defs.Machine, props.machineKey);
    const st = signal({
        roots: policyRootsOf(props.view.policy, props.view.policyDesired) as readonly string[],
        /** What the list was last reset from: a change reported by the machine replaces an untouched list. */
        base: policyRootsOf(props.view.policy, props.view.policyDesired) as readonly string[],
        requestId: '',
        busy: false,
        failure: null as string | null,
        notice: null as string | null
    });
    const browse = signal({ open: false, path: null as string | null, requestId: '', roots: null as MachineListing | null, listing: null as MachineListing | null, loading: false, error: null as string | null });

    // The machine reports a new set (its `env` frame, or the owner's save landing): an untouched list follows it.
    watch(() => JSON.stringify(policyRootsOf(props.view.policy, props.view.policyDesired)), (json) => {
        const next = JSON.parse(json) as string[];
        if (sameRoots(st.roots, st.base)) st.roots = next;
        st.base = next;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    onUnmounted(clearTimer);

    // Save: the answer read live, like `envResult`.
    const answer = useActorState(defs.Machine, () => (st.requestId ? ([props.machineKey, 'policyResult', st.requestId] as const) : null), { live: true });
    const stopAnswer = effect(() => {
        const r = answer.value;
        if (!r || r.requestId !== st.requestId || r.status === 'pending' || !st.busy) return;
        clearTimer();
        st.busy = false;
        if (r.status === 'done') {
            st.notice = 'Applied on the machine.';
            st.failure = null;
        } else st.failure = policyFailureText(r.error ? policyAnswerFailure(r.error) : { code: 'internal', message: 'The machine answered with something else' });
    });
    onUnmounted(stopAnswer);
    const save = (): Promise<void> => {
        const allowedRoots = [...st.roots];
        return props.elevate(async () => {
            if (st.busy) return;
            st.requestId = '';
            st.failure = null;
            st.notice = null;
            st.busy = true;
            try {
                const { requestId } = await client().setPolicy({ allowedRoots });
                st.requestId = requestId;
                clearTimer();
                timer = setTimeout(() => { if (st.busy) { st.busy = false; st.failure = policyFailureText({ code: 'timeout', message: '' }); } }, CLIENT_TIMEOUT_MS);
            } catch (e) {
                st.busy = false;
                // An elevation refusal is the helper's to turn into the dialog; anything else is the card's line.
                if (isElevationRequired(e)) throw e;
                st.failure = policyFailureText(policyCallFailure(e));
            }
        }, { allowedRoots });
    };

    // Browse: one listing at a time, read live the same way.
    const listing = useActorState(defs.Machine, () => (browse.requestId ? ([props.machineKey, 'policyResult', browse.requestId] as const) : null), { live: true });
    const stopListing = effect(() => {
        const r = listing.value;
        if (!r || r.requestId !== browse.requestId || r.status === 'pending' || !browse.loading) return;
        browse.loading = false;
        if (r.status === 'done' && r.result?.listing) {
            if (browse.path === null) browse.roots = r.result.listing;
            else browse.listing = r.result.listing;
        } else browse.error = policyFailureText(r.error ? policyAnswerFailure(r.error) : { code: 'internal', message: 'The machine answered with something else' });
    });
    onUnmounted(stopListing);
    const navigate = (path: string | null): Promise<void> =>
        props.elevate(async () => {
            browse.path = path;
            browse.error = null;
            browse.requestId = '';
            browse.loading = true;
            browse.open = true;
            try {
                const { requestId } = await client().browseMachine(path ?? undefined);
                browse.requestId = requestId;
            } catch (e) {
                browse.loading = false;
                if (isElevationRequired(e)) {
                    browse.open = false;
                    throw e;
                }
                browse.error = policyFailureText(policyCallFailure(e));
            }
        }, { allowedRoots: [...st.roots], browse: path });

    // Back from GitHub: the list is restored; a save waits for the page's Confirm click (it calls with `browse` absent), a browse reopens where it was.
    watch(() => props.resume, (r) => {
        if (!r) return;
        st.roots = [...r.allowedRoots];
        // Outside the watch's tracking: the request writes the state it reads, which would re-run this callback for good.
        untrack(() => { if (r.browse !== undefined) void navigate(r.browse); else void save(); });
    });

    return (): JSXElement => {
        const v = props.view;
        const state = policyCardState(v.policy, v.features);
        return (
            <>
                <PolicyCard
                    name={props.name}
                    os={props.os}
                    state={state}
                    {...(v.policy ? { policy: v.policy } : {})}
                    {...(v.policyDesired ? { desired: v.policyDesired } : {})}
                    roots={st.roots}
                    online={v.online}
                    busy={st.busy}
                    failure={st.failure}
                    notice={st.notice}
                    {...(props.timeZone ? { timeZone: props.timeZone } : {})}
                    {...(props.likelyRoot ? { likelyRoot: props.likelyRoot } : {})}
                    onAdd={(path: string) => { st.roots = [...st.roots, path]; st.notice = null; }}
                    onRemove={(path: string) => { st.roots = st.roots.filter((r) => r !== path); st.notice = null; }}
                    onBrowse={() => { void navigate(browse.roots ? browse.path : null); }}
                    onSave={() => { void save(); }}
                    onReset={() => { st.roots = st.base; st.failure = null; }}
                />
                <BrowseDialog
                    model={() => browse.open}
                    machineName={props.name}
                    os={props.os}
                    path={browse.path}
                    roots={browse.roots}
                    listing={browse.listing}
                    loading={browse.loading}
                    error={browse.error}
                    onNavigate={(path: string | null) => { void navigate(path); }}
                    onSelect={(path: string) => { if (!st.roots.includes(path)) st.roots = [...st.roots, path]; st.notice = null; }}
                    onCancel={() => { browse.open = false; }}
                />
            </>
        );
    };
});
