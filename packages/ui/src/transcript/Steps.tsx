/**
 * `Steps` — a turn's tool calls folded into one box (`ai-steps`, #1054, CHT-09;
 * `docs/design/chat-modes/HANDOFF.md` → "The turn", "Parts and rules"): a 32 px summary button
 * (chevron, `N steps · 3 commands, 2 reads · 1 failed, recovered`, the turn's time) and, open, one
 * 28 px line per step — status icon, tool, target, short result, duration — with a failed step's
 * output excerpt under its line: the picked lines on a 2 px `failed` border, the note
 * (`exit 1 · 2 of 14 lines, picked by error`) and `Full output`.
 *
 * The box starts shut and opens itself when a failure stopped the work (`turnOpensItself`); the
 * reader's toggle wins from then on. Given `open`, the box is controlled: it shows `open` and asks
 * `onToggle` for the change, so the page can remember each turn's state for the chat.
 */
import { component, type Define } from '@sigx/runtime-core';
import { formatExcerptNote, formatStepSummary, summariseSteps, turnOpensItself, type TranscriptStep, type TurnSteps } from '@agentic/core';
import { Icon } from '../kit/icons.js';
import { followDisclosure } from '../thread/disclosure.js';
import { aiStepsAnatomy } from './anatomy.js';
import { formatStepDuration, stepDuration, stepLook, stepResult } from './step-model.js';

const SCOPE = aiStepsAnatomy.scope;

/** Where a step's full output lives (the step in Session); no link when absent. */
export type StepHrefFn = (step: TranscriptStep) => string | undefined;

export type StepsProps =
    & Define.Prop<'steps', TurnSteps, true>
    /** Controlled open state; absent, the box keeps its own. */
    & Define.Prop<'open', boolean, false>
    /** The reader toggled the box: the state it asks for. */
    & Define.Prop<'onToggle', (open: boolean) => void, false>
    /** The `Full output` link of a failed step. */
    & Define.Prop<'fullHref', StepHrefFn, false>
    /** The clock a running step's time counts against; `Date.now()` by default. */
    & Define.Prop<'now', number, false>;

let nextId = 0;

const StepLine = component<Define.Prop<'step', TranscriptStep, true> & Define.Prop<'fullHref', StepHrefFn, false> & Define.Prop<'now', number, false>>(({ props }) => () => {
    const step = props.step;
    const look = stepLook(step.state);
    const result = stepResult(step);
    const output = step.state === 'error' ? step.output : undefined;
    const href = output ? props.fullHref?.(step) : undefined;
    return (
        <li data-scope={SCOPE} data-part="step" data-state={look.state}>
            <span data-scope={SCOPE} data-part="icon" role="img" aria-label={look.label}>
                {look.icon ? <Icon name={look.icon} size={13} /> : <i aria-hidden="true" />}
            </span>
            <span data-scope={SCOPE} data-part="tool">{step.tool}</span>
            <span data-scope={SCOPE} data-part="target" title={step.target}>{step.target}</span>
            <span data-scope={SCOPE} data-part="result">{result ?? ''}</span>
            <span data-scope={SCOPE} data-part="duration">{stepDuration(step, props.now)}</span>
            {output && (
                <div data-scope={SCOPE} data-part="excerpt">
                    {output.excerpt.map((line, i) => (
                        <div key={i} title={line}>{line}</div>
                    ))}
                    <div data-scope={SCOPE} data-part="excerpt-meta">
                        <span>{formatExcerptNote(output, step.exitCode)}</span>
                        {href && <a data-scope={SCOPE} data-part="full" href={href}>Full output</a>}
                    </div>
                </div>
            )}
        </li>
    );
}, { name: 'Steps.Step' });

export const Steps = component<StepsProps>(({ props }) => {
    const id = `ai-steps-${++nextId}`;
    const own = followDisclosure(() => turnOpensItself(props.steps));
    const isOpen = (): boolean => props.open ?? own.open;
    const toggle = (): void => {
        const next = !isOpen();
        if (props.open === undefined) {
            own.touched = true;
            own.open = next;
        }
        props.onToggle?.(next);
    };
    return () => {
        const steps = props.steps;
        const summary = summariseSteps(steps);
        const open = isOpen();
        return (
            <div data-scope={SCOPE} data-part="root">
                <button type="button" data-scope={SCOPE} data-part="summary" aria-expanded={open ? 'true' : 'false'} aria-controls={id} onClick={toggle}>
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
                    <span data-scope={SCOPE} data-part="label">{formatStepSummary(summary)}</span>
                    {summary.durationMs !== undefined && <span data-scope={SCOPE} data-part="total">{formatStepDuration(summary.durationMs)}</span>}
                </button>
                {open && (
                    <ol data-scope={SCOPE} data-part="list" id={id}>
                        {steps.steps.map((step) => (
                            <StepLine key={step.id} step={step} fullHref={props.fullHref} now={props.now} />
                        ))}
                    </ol>
                )}
            </div>
        );
    };
}, { name: 'Steps' });
