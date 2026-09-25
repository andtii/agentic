/**
 * `StageTrack` — a work item's stages as one segment each (docs/design/projects/HANDOFF.md, "Work"): a 132 px track of
 * 6 px segments with a 3 px gap; passed stages are `live`, the current one takes its state colour (`working`,
 * `needs-you`, `failed`; `live` when done), later ones `line-strong`; the current stage's name sits under it in mono
 * 11 px. Colour is never the only signal: the track's accessible name says the stage, its position and the state.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { WorkStageState } from '@agentic/core';

export type StageTrackProps =
    /** The project's stages (`workStagesFor`). */
    & Define.Prop<'stages', readonly string[], true>
    /** Index into `stages`. */
    & Define.Prop<'stage', number, true>
    & Define.Prop<'state', WorkStageState, true>
    /** Hide the current stage's name under the track. */
    & Define.Prop<'bare', boolean>
    & Define.Prop<'class', string>;

/** The colour token each state paints the current segment and name in. */
export const STAGE_STATE_COLOR: Readonly<Record<WorkStageState, string>> = {
    working: 'var(--color-info)',
    'needs-you': 'var(--color-warning)',
    failed: 'var(--color-error)',
    done: 'var(--color-primary)'
};

/** Each state in words, for the accessible name. */
export const STAGE_STATE_TEXT: Readonly<Record<WorkStageState, string>> = {
    working: 'agent working',
    'needs-you': 'needs you',
    failed: 'failed',
    done: 'done'
};

/** `stage` clamped into `stages`. */
const clampStage = (stages: readonly string[], stage: number): number => Math.min(Math.max(Math.trunc(stage) || 0, 0), Math.max(stages.length - 1, 0));

/** The track's accessible name: `Checks, stage 4 of 6, failed`. */
export function stageTrackLabel(stages: readonly string[], stage: number, state: WorkStageState): string {
    const at = clampStage(stages, stage);
    return `${stages[at] ?? 'No stage'}, stage ${Math.min(at + 1, stages.length)} of ${stages.length}, ${STAGE_STATE_TEXT[state]}`;
}

const rootStyle = 'display: inline-flex; flex-direction: column; gap: 5px; min-inline-size: 0; max-inline-size: 132px';
const trackStyle = 'display: flex; gap: 3px; inline-size: 132px';
const segmentBase = 'flex-grow: 1; flex-basis: 0; block-size: 6px; border-radius: 2px';
const nameBase = 'font-family: var(--font-mono); font-size: 11px; font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis';

export const StageTrack = component<StageTrackProps>(({ props }) => () => {
    const stages = props.stages;
    const at = clampStage(stages, props.stage);
    const current = STAGE_STATE_COLOR[props.state];
    const segment = (i: number) => {
        const phase = i < at ? 'passed' : i === at ? 'current' : 'later';
        const fill = phase === 'passed' ? 'var(--color-primary)' : phase === 'current' ? current : 'var(--ag-line-strong)';
        return <span data-segment={phase} style={`${segmentBase}; background-color: ${fill}`} />;
    };
    return (
        <span data-ag-project="stage-track" data-state={props.state} class={props.class} style={rootStyle} role="img" aria-label={stageTrackLabel(stages, props.stage, props.state)}>
            <span style={trackStyle} aria-hidden="true">{stages.map((_, i) => segment(i))}</span>
            {props.bare ? null : <span data-stage-name="" style={`${nameBase}; color: ${current}`} aria-hidden="true">{stages[at] ?? ''}</span>}
        </span>
    );
}, { name: 'StageTrack' });
