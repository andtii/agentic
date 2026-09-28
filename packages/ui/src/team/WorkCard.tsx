/**
 * `WorkCard` — one agent's card per assignment, updated in place (`ai-work-card`, #1057, CHT-09;
 * `docs/design/chat-modes/HANDOFF.md` → "Team"). The header holds the tile, the name, a turning ring
 * or a check, the task, `23 steps · 4m 12s` and a `Follow` / `Following` button; under it the last 3
 * steps while the agent works (the `ai-steps` step line), or the result as 13 px prose once it is
 * done. While it runs, the border is `working` at 33 %.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { TranscriptStep } from '@agentic/core';
import { AgentTile } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import type { StepHrefFn } from '../transcript/Steps.js';
import { aiWorkCardAnatomy } from './anatomy.js';
import { crewLifecycle, crewStateLabel, elapsedOf, formatWorkMeta, type CrewState, type TeamAgent } from './model.js';
import { markContent, StepList } from './StepList.js';

const SCOPE = aiWorkCardAnatomy.scope;

/** How many of the latest steps a working card shows. */
export const WORK_CARD_STEPS = 3;

export type WorkCardProps =
    & Define.Prop<'agent', TeamAgent, true>
    & Define.Prop<'state', CrewState, true>
    /** The assignment: `Real register build · #21`. */
    & Define.Prop<'task', string, true>
    /** The steps so far; a working card shows the last three. */
    & Define.Prop<'steps', readonly TranscriptStep[], false>
    /** The step count when the card holds only the latest steps; `steps.length` by default. */
    & Define.Prop<'stepCount', number, false>
    & Define.Prop<'startedAt', number, false>
    & Define.Prop<'endedAt', number, false>
    & Define.Prop<'now', number, false>
    /** The result prose once done. */
    & Define.Prop<'result', string, false>
    /** The agent is being followed: the button reads `Following`. */
    & Define.Prop<'following', boolean, false>
    & Define.Prop<'onFollow', () => void, false>
    & Define.Prop<'fullHref', StepHrefFn, false>;

export const WorkCard = component<WorkCardProps>(({ props }) => () => {
    const state = props.state;
    const steps = props.steps ?? [];
    const working = state === 'working' || state === 'needs-you' || state === 'idle';
    const now = props.now ?? Date.now();
    return (
        <article data-scope={SCOPE} data-part="root" data-state={crewLifecycle(state)}>
            <div data-scope={SCOPE} data-part="head">
                <AgentTile name={props.agent.name} hue={props.agent.hue} size={20} />
                <span data-scope={SCOPE} data-part="name">{props.agent.name}</span>
                <span data-scope={SCOPE} data-part="mark" role="img" aria-label={crewStateLabel(state)}>{markContent(state === 'working', state === 'done')}</span>
                <span data-scope={SCOPE} data-part="task" title={props.task}>{props.task}</span>
                <span data-scope={SCOPE} data-part="meta">{formatWorkMeta(props.stepCount ?? steps.length, elapsedOf(props.startedAt, props.endedAt, now))}</span>
                {props.onFollow && (
                    <span data-scope={SCOPE} data-part="follow">
                        <Button intent="default" onClick={() => props.onFollow?.()}>{props.following ? 'Following' : 'Follow'}</Button>
                    </span>
                )}
            </div>
            {!working && props.result !== undefined
                ? <div data-scope={SCOPE} data-part="result">{props.result}</div>
                : steps.length > 0 && <StepList steps={steps.slice(-WORK_CARD_STEPS)} fullHref={props.fullHref} now={now} />}
        </article>
    );
}, { name: 'WorkCard' });
