/**
 * A live actor read for an app store (#1116). `useActorState(…, { live: true })`
 * cannot be torn down by a store: in `@sigx/actors` 0.11 it registers the live
 * subscription's `onUnmounted` from inside an `onMounted` callback, where the
 * current instance is not the reading component (none on the first mount, the
 * re-rendering parent later), so the subscription outlives its component and
 * nothing the store owns can close it (signalxjs/actors#494). This read is the ordinary
 * `useActorState` (SSR-seeded, hydrated without a refetch, invalidated by
 * `useActorAction`) plus a subscription on the app's live channel that the
 * store opens itself and closes in `ctx.onDeactivated` — the pattern of
 * `apps/web/src/pages/chat/directory.ts`.
 */
import { actorKey, type ActorReadName, type ActorResult, type AnyActorDefinition } from '@sigx/actors';
import { useActorState, useActorsContext, type ActorCall, type ActorLiveChannel } from '@sigx/actors/app';
import { effect, signal, untrack } from '@sigx/reactivity';
import type { AsyncState, SetupFactoryContext } from '@sigx/runtime-core';

type Falsy = null | undefined | false | '';

/** What a live store read exposes: the pushed value once one arrived, else the fetched one. */
export interface LiveActorState<T> {
    readonly state: AsyncState<T>['state'];
    readonly value: T | undefined;
    readonly hasValue: boolean;
    readonly loading: boolean;
    readonly error: unknown;
    /** Re-read; the fetched value answers until the next push. */
    refresh(): Promise<unknown>;
}

/**
 * Read `def` at `call()` live, for as long as the store lives. `call` is reactive (a
 * workspace from `useViewer()`, say): a new key closes the old subscription and opens
 * the new one; a falsy one reads nothing. Call it in a store's setup only.
 */
export function useLiveActorState<D extends AnyActorDefinition, M extends ActorReadName<D>>(ctx: Pick<SetupFactoryContext, 'onDeactivated'>, def: D, call: () => ActorCall<D, M> | Falsy): LiveActorState<ActorResult<D, M>> {
    const read = useActorState(def, call);
    const pushed = signal({ has: false, value: undefined as unknown, error: null as unknown });
    const channel: ActorLiveChannel = useActorsContext().live;
    let subscribed: string | null = null;
    let off: (() => void) | null = null;
    const close = (): void => {
        off?.();
        off = null;
    };
    const runner = effect(() => {
        const tuple = call();
        const wire = tuple ? (actorKey as (d: D, key: string, method: string, ...args: unknown[]) => readonly unknown[])(def, tuple[0], tuple[1], ...tuple.slice(2)) : null;
        const canonical = wire ? JSON.stringify(wire) : null;
        // Tracked: a settle of the read's own is newer than anything pushed before it.
        const settled = read.state === 'ready' || read.state === 'errored';
        void read.value;
        untrack(() => {
            if (canonical === subscribed) {
                if (settled) pushed.has = false;
                return;
            }
            subscribed = canonical;
            close();
            pushed.has = false;
            pushed.error = null;
            if (!wire) return;
            const [, type, key, method, ...args] = wire as [string, string, string, string, ...unknown[]];
            off = channel.subscribe(
                { type, key, method, args },
                (value: unknown) => {
                    pushed.value = value;
                    pushed.error = null;
                    pushed.has = true;
                },
                (error: Error) => {
                    pushed.has = false;
                    pushed.error = error;
                }
            );
        });
    });
    ctx.onDeactivated(() => {
        runner.stop();
        close();
        subscribed = null;
    });
    return {
        get state() {
            return pushed.has ? 'ready' : read.state;
        },
        get value() {
            return (pushed.has ? pushed.value : read.value) as ActorResult<D, M> | undefined;
        },
        get hasValue() {
            return pushed.has || read.hasValue;
        },
        get loading() {
            return !pushed.has && read.loading;
        },
        get error() {
            return pushed.has ? null : (read.error ?? pushed.error);
        },
        refresh() {
            pushed.has = false;
            return read.refresh();
        }
    };
}
