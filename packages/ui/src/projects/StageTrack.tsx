/**
 * `StageTrack` — a work item's stages as one segment each: passed, the current one in its state, then the rest
 * (#725 stub; #726 draws it). Props are final.
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

export const StageTrack = component<StageTrackProps>(({ props }) => () => (
    <span data-ag-project="stage-track" data-state={props.state} class={props.class}>
        {props.bare ? null : props.stages[props.stage]}
    </span>
), { name: 'StageTrack' });
