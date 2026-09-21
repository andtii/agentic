/**
 * `FailureNotice` — a `FailureState` (from `failureOf`) on the design
 * track's `FailureCard`, with the one action each kind has wired to what a
 * page can do: `Open task` / `Open machine` are links, `Resume` re-prompts
 * an interrupted turn (`onResume`), `Retry turn` re-issues the last prompt
 * (`onRetry`), `Re-check` re-reads the machine (`onRecheck`); the offline
 * card's "Reconnecting…" stays disabled. Interrupted work carries the
 * uncertainty line of OPS-05 under the card, so nobody repeats a side
 * effect on the strength of a partial turn.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { FailureCard, type FailureAction } from '@agentic/ui';
import type { FailureState } from './failure';

export type FailureNoticeProps =
    & Define.Prop<'state', FailureState, true>
    /** "Resume" on an interrupted turn: a new prompt over the intact transcript. */
    & Define.Prop<'onResume', () => void>
    /** "Retry turn" after a runtime error. */
    & Define.Prop<'onRetry', () => void>
    /** "Re-check" the machine's account. */
    & Define.Prop<'onRecheck', () => void>
    /** The action is in flight. */
    & Define.Prop<'busy', boolean>
    /** The card sits in a thread that already has the action: no button. */
    & Define.Prop<'noAction', boolean>
    & Define.Prop<'class', string>;

export const UNCERTAIN_LINE = 'What ran before the cut is uncertain: check the outcome before repeating anything with side effects.';

/** The action a state gets on a page: a link where the state names a place, a callback where the page has one, nothing otherwise. */
export function failureAction(state: FailureState, handlers: { onResume?: () => void; onRetry?: () => void; onRecheck?: () => void; busy?: boolean }): FailureAction | null {
    const loading = handlers.busy ?? false;
    switch (state.kind) {
        case 'client-offline':
            return {};
        case 'machine':
            // A lost turn (`machine-lost`) is sent again where the page can; otherwise the machine is where to look.
            if (state.retry && handlers.onRetry) return { onAction: handlers.onRetry, loading, label: 'Retry' };
            return { href: state.machineId ? `/machines/${state.machineId}` : '/machines' };
        case 'auth':
            return handlers.onRecheck ? { onAction: handlers.onRecheck, loading } : { href: state.machineId ? `/machines/${state.machineId}` : '/machines', label: 'Open machine' };
        case 'runtime':
            return handlers.onRetry ? { onAction: handlers.onRetry, loading } : state.taskId ? { href: `/tasks/${state.taskId}`, label: 'Open task' } : null;
        case 'task':
            return state.link ? { href: state.link.href, label: state.link.label } : state.taskId ? { href: `/tasks/${state.taskId}` } : null;
        case 'interrupted':
            // Resume is the one action; a page that cannot issue it shows it disabled rather than pretending — and so
            // does one whose resume is already under way (#368): the route re-opening the session, or `onInterrupt: 'auto'`.
            if (state.resume === 'auto') return { disabled: true, label: 'Resuming automatically' };
            if (state.resume === 'resuming') return { disabled: true, loading: true, label: 'Resuming…' };
            return handlers.onResume ? { onAction: handlers.onResume, loading } : { disabled: true };
    }
}

export const FailureNotice = component<FailureNoticeProps>(({ props }) => (): JSXElement => {
    const { state } = props;
    const action = failureAction(state, { ...(props.onResume ? { onResume: props.onResume } : {}), ...(props.onRetry ? { onRetry: props.onRetry } : {}), ...(props.onRecheck ? { onRecheck: props.onRecheck } : {}), ...(props.busy !== undefined ? { busy: props.busy } : {}) });
    return (
        <div data-failure-notice data-failure-kind={state.kind} data-uncertain={state.uncertain ? '' : undefined} class={props.class}>
            <FailureCard kind={state.kind} detail={state.detail} {...(state.signal ? { signal: state.signal } : {})} {...(action ? { action } : {})} noAction={props.noAction || action === null} />
            {state.uncertain ? <p data-failure-uncertain role="note">{UNCERTAIN_LINE}</p> : null}
        </div>
    );
}, { name: 'FailureNotice' });
