/**
 * `Lane` — one working agent's column in the Lanes view (`ai-lane`, #1057, COL-09;
 * `docs/design/chat-modes/HANDOFF.md` → "Lanes"). The header holds the tile, the name, the state
 * mark, the elapsed time (`waits 6m` while it waits on you) and the task; the body its steps (the
 * `ai-steps` step line) and its messages in order, as 12 px boxes with an optional `to Atlas` label;
 * the footer `Done · #22 ticked`, or the open question with its answer buttons on a `needs-you` tint.
 */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import type { TranscriptStep } from '@agentic/core';
import { AgentTile } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { Icon } from '../kit/icons.js';
import type { StepHrefFn } from '../transcript/Steps.js';
import { aiLaneAnatomy } from './anatomy.js';
import { crewLifecycle, crewStateLabel, elapsedOf, type CrewState, type TeamAgent } from './model.js';
import { markContent, StepList } from './StepList.js';

const SCOPE = aiLaneAnatomy.scope;

/** A lane's body, in order: a step, or a message (with the agent it is `to`, when not for people). */
export type LaneEntry =
    | { readonly kind: 'step'; readonly step: TranscriptStep }
    | { readonly kind: 'message'; readonly id: string; readonly text: string; readonly to?: string };

/** The question a lane's footer asks, and the answers it offers. */
export interface LaneQuestion {
    readonly text: string;
    readonly options: readonly string[];
}

export type LaneProps =
    & Define.Prop<'agent', TeamAgent, true>
    & Define.Prop<'state', CrewState, true>
    /** `#21 · Real register build`. */
    & Define.Prop<'task', string, true>
    & Define.Prop<'entries', readonly LaneEntry[], false>
    & Define.Prop<'startedAt', number, false>
    & Define.Prop<'endedAt', number, false>
    & Define.Prop<'now', number, false>
    /** The done footer: `Done · #22 ticked`. */
    & Define.Prop<'done', string, false>
    /** The open question: the footer asks it on a `needs-you` tint. */
    & Define.Prop<'question', LaneQuestion, false>
    & Define.Prop<'onAnswer', (option: string) => void, false>
    & Define.Prop<'fullHref', StepHrefFn, false>;

/** Consecutive steps share one list; a message breaks the run. */
function body(entries: readonly LaneEntry[], fullHref: StepHrefFn | undefined, now: number): JSXElement[] {
    const out: JSXElement[] = [];
    let run: TranscriptStep[] = [];
    const flush = (): void => {
        if (run.length) out.push(<StepList key={`s-${run[0]!.id}`} steps={run} fullHref={fullHref} now={now} />);
        run = [];
    };
    for (const e of entries) {
        if (e.kind === 'step') {
            run.push(e.step);
            continue;
        }
        flush();
        out.push(
            <div key={`m-${e.id}`} data-scope={SCOPE} data-part="message">
                {e.to && <div data-scope={SCOPE} data-part="to">to {e.to}</div>}
                {e.text}
            </div>
        );
    }
    flush();
    return out;
}

export const Lane = component<LaneProps>(({ props }) => () => {
    const state = props.state;
    const now = props.now ?? Date.now();
    const elapsed = elapsedOf(props.startedAt, props.endedAt, now);
    const q = props.question;
    return (
        <section data-scope={SCOPE} data-part="root" data-state={crewLifecycle(state)} aria-label={props.agent.name}>
            <header data-scope={SCOPE} data-part="head">
                <AgentTile name={props.agent.name} hue={props.agent.hue} size={22} />
                <span data-scope={SCOPE} data-part="name">{props.agent.name}</span>
                <span data-scope={SCOPE} data-part="mark" role="img" aria-label={crewStateLabel(state)}>{markContent(state === 'working')}</span>
                <span data-scope={SCOPE} data-part="elapsed">{state === 'needs-you' && elapsed !== '–' ? `waits ${elapsed}` : elapsed}</span>
                <div data-scope={SCOPE} data-part="task" title={props.task}>{props.task}</div>
            </header>
            <div data-scope={SCOPE} data-part="body">{body(props.entries ?? [], props.fullHref, now)}</div>
            {q
                ? (
                    <footer data-scope={SCOPE} data-part="question">
                        <div>{q.text}</div>
                        <div data-scope={SCOPE} data-part="answers">
                            {q.options.map((o) => (
                                <Button key={o} intent="default" onClick={() => props.onAnswer?.(o)}>{o}</Button>
                            ))}
                        </div>
                    </footer>
                )
                : props.done && (
                    <footer data-scope={SCOPE} data-part="footer">
                        <Icon name="check" size={13} />
                        <span>{props.done}</span>
                    </footer>
                )}
        </section>
    );
}, { name: 'Lane' });
