/**
 * Focus (#1058, CHT-09; `docs/design/chat-modes/HANDOFF.md` → "Focus"): the thread at the chat's detail
 * level — a finished turn is its prose and one steps box, the turn in flight folds its tool parts the same
 * way — and one live line per agent at work under the last turn, with its Stop.
 */
import { component } from 'sigx';
import { LiveLine, Thread, type ThreadInsert } from '@agentic/ui';
import type { ChatViewProps, LiveWork } from '../types';

/** Where the live lines sit: after every message (an in-flight row, with no time, counts as later than any finite time), while the thread shows its tail. */
const AFTER_ALL = Number.POSITIVE_INFINITY;

/** The live lines as thread rows after the last turn. */
export function liveInserts(live: readonly LiveWork[]): ThreadInsert[] {
    return live.map((w) => ({
        key: `live:${w.agentId}`,
        at: AFTER_ALL,
        render: () => (
            <div data-chat-live={w.agentId}>
                <LiveLine agent={w.name} hue={w.hue} step={w.step} startedAt={w.startedAt} onStop={w.onStop} />
            </div>
        )
    }));
}

export const FocusView = component<ChatViewProps>(({ props }) => () => {
    const v = props.view;
    const inserts = [...(v.thread.inserts ?? []), ...liveInserts(v.live)];
    return (
        <Thread
            {...v.thread}
            inserts={inserts}
            detail={v.detail}
            stepsOpen={v.stepsOpen}
            onStepsToggle={v.onStepsToggle}
            stepHref={v.stepHref}
        />
    );
}, { name: 'ChatFocusView' });
