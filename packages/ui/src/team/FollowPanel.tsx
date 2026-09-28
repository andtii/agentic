/**
 * `FollowPanel` — the 330 px right column that follows one agent (`ai-follow`, #1057, CHT-09;
 * `docs/design/chat-modes/HANDOFF.md` → "Team"): `Following Forge` with a close button (`close`), the
 * task and its environment with the step count, the last steps (the `ai-steps` step line), the last
 * lines of live output in a `pre` ending in a cursor while the agent works, the result once it is
 * done, `Message Forge` and a danger-style `Stop`. Following never writes to the thread.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { TranscriptStep } from '@agentic/core';
import { AgentTile } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import type { StepHrefFn } from '../transcript/Steps.js';
import { aiFollowAnatomy } from './anatomy.js';
import { formatWorkMeta, type CrewState, type TeamAgent } from './model.js';
import { StepList } from './StepList.js';

const SCOPE = aiFollowAnatomy.scope;

/** How many of the latest steps and output lines the panel keeps. */
export const FOLLOW_STEPS = 6;
export const FOLLOW_LINES = 8;

export type FollowPanelProps =
    & Define.Prop<'agent', TeamAgent, true>
    & Define.Prop<'state', CrewState, true>
    /** `Real register build · #21`. */
    & Define.Prop<'task', string, true>
    /** `machine / runtime`: `alien01 / claude-code`. */
    & Define.Prop<'env', string, false>
    & Define.Prop<'steps', readonly TranscriptStep[], false>
    /** The step count when `steps` holds only the latest; `steps.length` by default. */
    & Define.Prop<'stepCount', number, false>
    /** The live output so far, one entry per line; the panel shows the last lines. */
    & Define.Prop<'output', readonly string[], false>
    /** The result once the agent is done. */
    & Define.Prop<'result', string, false>
    & Define.Prop<'now', number, false>
    & Define.Prop<'onMessage', () => void, false>
    & Define.Prop<'onStop', () => void, false>
    & Define.Prop<'onClose', () => void, false>
    & Define.Prop<'fullHref', StepHrefFn, false>;

export const FollowPanel = component<FollowPanelProps>(({ props }) => () => {
    const name = props.agent.name;
    const steps = props.steps ?? [];
    const output = (props.output ?? []).slice(-FOLLOW_LINES);
    const live = props.state === 'working';
    // Waiting on you is still a turn in flight: it can be stopped, though nothing streams.
    const stoppable = live || props.state === 'needs-you';
    const meta = formatWorkMeta(props.stepCount ?? steps.length);
    return (
        <aside data-scope={SCOPE} data-part="root" aria-label={`Following ${name}`}>
            <div data-scope={SCOPE} data-part="head">
                <h2 data-scope={SCOPE} data-part="title">Following {name}</h2>
                {props.onClose && <Button intent="icon" icon="close" label="Close" onClick={() => props.onClose?.()} />}
            </div>
            <div data-scope={SCOPE} data-part="task" title={props.task}>
                <AgentTile name={name} hue={props.agent.hue} size={22} />
                <span>{props.task}</span>
            </div>
            <div data-scope={SCOPE} data-part="env">{props.env ? `${props.env} · ${meta}` : meta}</div>
            {steps.length > 0 && <h3 data-scope={SCOPE} data-part="label">Last steps</h3>}
            {steps.length > 0 && <StepList steps={steps.slice(-FOLLOW_STEPS)} fullHref={props.fullHref} now={props.now} />}
            {(live || output.length > 0) && <h3 data-scope={SCOPE} data-part="label">Live output</h3>}
            {(live || output.length > 0) && (
                <pre data-scope={SCOPE} data-part="output">
                    {output.join('\n')}
                    {output.length > 0 && live ? '\n' : ''}
                    {live && <span data-scope={SCOPE} data-part="cursor" aria-hidden="true" />}
                </pre>
            )}
            {!stoppable && props.result !== undefined && <div data-scope={SCOPE} data-part="result">{props.result}</div>}
            {(props.onMessage || (stoppable && props.onStop)) && (
                <div data-scope={SCOPE} data-part="actions">
                    {props.onMessage && <Button intent="default" icon="chats" onClick={() => props.onMessage?.()}>Message {name}</Button>}
                    {stoppable && props.onStop && <Button intent="danger" icon="stop" onClick={() => props.onStop?.()}>Stop</Button>}
                </div>
            )}
            <p data-scope={SCOPE} data-part="note">Following never adds to the thread. Close it and the chat stays as calm as before.</p>
        </aside>
    );
}, { name: 'FollowPanel' });
