/**
 * `TaskNode` — one node of a delegation tree (`docs/design/HANDOFF.md` →
 * "Components", Task). A depth rail (one 28 px column per level with a
 * `line-strong` left border) and a card: tile 28, title, agent + environment
 * line, the wait reason in amber mono, the status pill. `selected` = base-300
 * fill and a `live` border at 53 %. The card is a real button: selecting a
 * node swaps the page's right rail. Depth indents to 3, the configured
 * maximum; beyond that the limit blocks creation. A task whose result is a
 * pull request shows it on the node as `PullCard`'s `task` line
 * (`#602 · ready to merge`, PRJ-10) — the same state as everywhere else.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PullRequest, TaskId, TaskStatus, WaitReason } from '@agentic/core';
import { PullCard } from '../projects/PullCard.js';
import { AgentTile, type AgentHue } from './AgentTile.js';
import { agTaskNodeAnatomy } from './anatomy.js';
import { EnvironmentLine, type EnvironmentParts } from './EnvironmentLine.js';
import { StatusPill, WaitReasonLine } from './StatusPill.js';

const SCOPE = agTaskNodeAnatomy.scope;

export type TaskNodeProps =
    & Define.Prop<'id', TaskId, true>
    & Define.Prop<'title', string, true>
    & Define.Prop<'status', TaskStatus, true>
    & Define.Prop<'agent', string, true>
    & Define.Prop<'hue', AgentHue>
    & Define.Prop<'environment', EnvironmentParts>
    & Define.Prop<'wait', WaitReason>
    & Define.Prop<'waitDetail', string>
    /** The pull request the task's result is; the node shows its one-line state. */
    & Define.Prop<'pull', PullRequest>
    /** 0 at the root; the rail indents 28 px per level. */
    & Define.Prop<'depth', number>
    & Define.Prop<'selected', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'select', TaskId>;

export const TaskNode = component<TaskNodeProps>(({ props, emit }) => () => {
    const depth = Math.max(0, props.depth ?? 0);
    return (
        <div data-scope={SCOPE} data-part="root" data-depth={depth} data-mod-selected={props.selected ? '' : undefined} style={`--ag-depth: ${depth}`} class={props.class}>
            {depth > 0 ? <span data-scope={SCOPE} data-part="rail" aria-hidden="true" /> : null}
            <button data-scope={SCOPE} data-part="card" type="button" aria-pressed={props.selected ? 'true' : 'false'} aria-label={`${props.title} — ${props.status}`} onClick={() => emit('select', props.id)}>
                <span data-scope={SCOPE} data-part="tile"><AgentTile name={props.agent} hue={props.hue} size={28} /></span>
                <span data-scope={SCOPE} data-part="title" title={props.title}>{props.title}</span>
                <span data-scope={SCOPE} data-part="meta">
                    <span>{props.agent}</span>
                    {props.environment ? <EnvironmentLine tone="dim" {...props.environment} /> : null}
                </span>
                {props.pull ? <span data-pull-line="" style="grid-column: 2; display: flex; min-inline-size: 0"><PullCard pull={props.pull} surface="task" /></span> : null}
                {props.wait ? <WaitReasonLine wait={props.wait} detail={props.waitDetail} /> : null}
                <span data-scope={SCOPE} data-part="status"><StatusPill status={props.status} /></span>
            </button>
        </div>
    );
}, { name: 'TaskNode' });
