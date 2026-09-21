/**
 * "Runtimes on this machine" on the platform (#370): the rows come from the
 * `Machine.get()` the page already reads live — `harnesses` (the daemon's
 * `hello` and `harnesses` frames), `harnessesAvailable` (the release on the
 * machine's channel), its environments and sessions. Install / Update /
 * Remove is `requestHarness`; the request is then followed with a live
 * `harnessResult(requestId)`, the way the environment requests are
 * (`LiveMachine`), and a client timer says so when the daemon has not
 * reported in `CLIENT_TIMEOUT_MS`. A request asked elsewhere (or before a
 * reload) shows from `get().harnessRequest` until it ends.
 */
import { component, effect, onUnmounted, signal, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { HostOs, RuntimeId } from '@agentic/core';
import type { MachineView } from '@agentic/platform';
import { useActorDefs } from '../../actors/defs';
import { CLIENT_TIMEOUT_MS } from '../workdir/model';
import { pageOrigin } from './LivePair';
import { HarnessCard, type HarnessAsk } from './HarnessCard';
import { harnessNeedsReinstall, harnessRows, refusalText, type HarnessTurn } from './harness';

/** What the card says when the daemon has not reported on a harness request in time. */
export const HARNESS_SLOW = 'The daemon has not reported on the request yet. It stays pending until the daemon does, or until the platform gives up on it.';

export type LiveHarnessCardProps =
    & Define.Prop<'machineKey', string, true>
    & Define.Prop<'view', MachineView, true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    & Define.Prop<'turnLabel', (turn: HarnessTurn) => string>;

export const LiveHarnessCard = component<LiveHarnessCardProps>(({ props }) => {
    const defs = useActorDefs();
    const client = () => actor(defs.Machine, props.machineKey);
    const st = signal({ requestId: '', busy: false, waiting: false, failure: null as { runtime: string; text: string } | null, reinstall: false });
    const answer = useActorState(defs.Machine, () => (st.requestId ? ([props.machineKey, 'harnessResult', st.requestId] as const) : null), { live: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    onUnmounted(clearTimer);
    // The request settles once the daemon reports a phase for it, or it has ended.
    const stopFollow = effect(() => {
        const r = answer.value;
        if (!st.waiting || !r || r.requestId !== st.requestId) return;
        if (r.status === 'pending' && !r.phase) return;
        st.waiting = false;
        clearTimer();
    });
    onUnmounted(stopFollow);

    const ask = async (a: HarnessAsk): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.failure = null;
        try {
            const { requestId } = await client().requestHarness({ op: a.op, runtime: a.runtime as RuntimeId, mode: a.mode });
            st.requestId = requestId;
            st.waiting = true;
            clearTimer();
            timer = setTimeout(() => { if (st.waiting) { st.waiting = false; st.failure = { runtime: a.runtime, text: HARNESS_SLOW }; } }, CLIENT_TIMEOUT_MS);
        } catch (e) {
            if (harnessNeedsReinstall(e)) st.reinstall = true;
            else st.failure = { runtime: a.runtime, text: refusalText(e) };
        } finally {
            st.busy = false;
        }
    };

    return (): JSXElement => {
        const v = props.view;
        const own = answer.value && answer.value.requestId === st.requestId ? answer.value : null;
        // Ours while it lasts; else the one in flight the record reports.
        const request = own ?? v.harnessRequest ?? null;
        return (
            <HarnessCard
                rows={harnessRows(v)}
                name={props.name}
                os={props.os}
                origin={pageOrigin()}
                online={v.online}
                able={(v.features ?? []).includes('harness')}
                current={request}
                busy={st.busy}
                failure={st.failure}
                reinstall={st.reinstall}
                turnLabel={props.turnLabel}
                onRequest={(a: HarnessAsk) => { void ask(a); }}
            />
        );
    };
});
