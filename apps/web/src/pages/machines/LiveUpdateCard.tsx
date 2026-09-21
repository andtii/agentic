/**
 * The update card on the platform (#367): `Machine.updateState()` read live
 * — the build, what is available, the pending update's phases as the
 * daemon's `update.status` frames land, how the last one ended, what an
 * update now would interrupt — and the Workspace's `settings.updates` as
 * the defaults. The owner's actions are `requestUpdate` (`drain`, `now`, or
 * `previous` to roll back), `cancelUpdate`, `setChannel` and
 * `setUpdatePolicy`. Opening the card checks for updates (`checkUpdates`, #468),
 * and "Check for updates" does it again.
 *
 * A request is followed the way the environment requests are
 * (`LiveMachine`): its id, then the live read settles it — the first phase
 * the daemon reports, or the outcome — and a client timer says so when the
 * daemon has not answered in `CLIENT_TIMEOUT_MS`. No polling.
 */
import { component, effect, onMounted, onUnmounted, signal, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { DEFAULT_UPDATE_SETTINGS, type HostOs, type ReleaseChannel } from '@agentic/core';
import { useActorDefs, useViewer } from '../../actors/defs';
import { workspaceKeyOf } from '../../actors/keys';
import { CLIENT_TIMEOUT_MS } from '../workdir/model';
import { pageOrigin } from './LivePair';
import { UpdateCard, type TurnLabel } from './UpdateCard';
import type { UpdateChoice } from './UpdatePolicyForm';
import { needsReinstall, samePolicy } from './update';

/** What the page says when the daemon has not answered an update request in time. */
export const UPDATE_SLOW = 'The daemon has not answered the update request yet. It stays pending until the daemon reports, or until the platform gives up on it.';

export type LiveUpdateCardProps =
    & Define.Prop<'machineKey', string, true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    & Define.Prop<'daemonVersion', string>
    & Define.Prop<'turnLabel', TurnLabel>;

export const LiveUpdateCard = component<LiveUpdateCardProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const view = useActorState(defs.Machine, () => [props.machineKey, 'updateState'] as const, { live: true });
    const workspace = useActorState(defs.Workspace, () => { const ws = viewer.workspaceId; return ws && ([workspaceKeyOf(ws), 'get'] as const); }, { live: true });
    const client = () => actor(defs.Machine, props.machineKey);

    const st = signal({ busy: false, failure: null as string | null, reinstall: false, requestId: '', waiting: false, checking: false });

    /** Read the release manifests now (#468): once as the page opens, and on "Check for updates" — the directory reads GitHub at most every few minutes. */
    const check = async (): Promise<void> => {
        if (st.checking) return;
        st.checking = true;
        try {
            await client().checkUpdates();
        } catch {
            // The live read keeps what it had; the hourly read still runs.
        } finally {
            st.checking = false;
        }
    };
    // Once the card is on the page, never during setup (SSR, hydration).
    onMounted(() => { void check(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    onUnmounted(clearTimer);
    // The request settles once the daemon reports a phase for it, or it has ended (the outcome is `last`).
    const stopFollow = effect(() => {
        const u = view.value;
        if (!u || !st.waiting || !st.requestId) return;
        const reported = u.pending?.requestId === st.requestId && !!u.pending.phase;
        const ended = !u.pending && u.last?.requestId === st.requestId;
        if (!reported && !ended) return;
        st.waiting = false;
        clearTimer();
    });
    onUnmounted(stopFollow);

    const act = async (run: () => Promise<unknown>): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.failure = null;
        try {
            await run();
        } catch (e) {
            if (needsReinstall(e)) st.reinstall = true;
            else st.failure = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    const request = (input: { target?: string; mode: 'drain' | 'now' }): Promise<void> =>
        act(async () => {
            const { requestId } = await client().requestUpdate(input);
            st.requestId = requestId;
            st.waiting = true;
            clearTimer();
            timer = setTimeout(() => { if (st.waiting) { st.waiting = false; st.failure = UPDATE_SLOW; } }, CLIENT_TIMEOUT_MS);
        });
    const saveUpdates = (choice: UpdateChoice): Promise<void> =>
        act(async () => {
            const u = view.value;
            if (!u) return;
            const channel: ReleaseChannel | null = u.inherited.channel ? null : u.channel;
            const policy = u.inherited.policy ? null : u.policy;
            if (choice.channel !== channel) await client().setChannel(choice.channel);
            if (!samePolicy(choice.policy, policy)) await client().setUpdatePolicy(choice.policy);
        });

    return (): JSXElement | null => {
        const u = view.value;
        if (!u) return null;
        const settings = workspace.value?.settings;
        return (
            <UpdateCard
                update={u}
                name={props.name}
                os={props.os}
                daemonVersion={props.daemonVersion}
                origin={pageOrigin()}
                timeZone={settings?.timeZone ?? 'UTC'}
                defaults={settings?.updates ?? DEFAULT_UPDATE_SETTINGS}
                turnLabel={props.turnLabel}
                now={Date.now()}
                busy={st.busy}
                failure={st.failure}
                reinstall={st.reinstall}
                onRequest={(mode: 'drain' | 'now') => { void request({ mode }); }}
                onRollback={() => { void request({ target: 'previous', mode: 'drain' }); }}
                onCancel={() => { void act(async () => { st.waiting = false; clearTimer(); await client().cancelUpdate(); }); }}
                onSaveUpdates={(choice: UpdateChoice) => { void saveUpdates(choice); }}
                checking={st.checking}
                onCheck={() => { void check(); }}
            />
        );
    };
});
