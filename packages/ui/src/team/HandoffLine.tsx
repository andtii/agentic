/**
 * `HandoffLine` — one delegation as a 24 px row (`ai-handoff`, #1057; `docs/design/chat-modes/HANDOFF.md`
 * → "Team"): a send icon, the sender's tile and name, a chevron, the receiver's tile and name, the task
 * text and the item ref chip. It stands in for the agent-to-agent message that created the work.
 */
import { component, type Define } from '@sigx/runtime-core';
import { AgentTile } from '../kit/AgentTile.js';
import { Icon } from '../kit/icons.js';
import { aiHandoffAnatomy } from './anatomy.js';
import type { TeamAgent } from './model.js';

const SCOPE = aiHandoffAnatomy.scope;

export type HandoffLineProps =
    & Define.Prop<'from', TeamAgent, true>
    & Define.Prop<'to', TeamAgent, true>
    & Define.Prop<'task', string, true>
    /** The plan item or task ref: `#21`. */
    & Define.Prop<'itemRef', string, false>;

export const HandoffLine = component<HandoffLineProps>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="root">
        <span data-scope={SCOPE} data-part="icon" role="img" aria-label="handed off"><Icon name="send" size={13} /></span>
        <span data-scope={SCOPE} data-part="from">
            <AgentTile name={props.from.name} hue={props.from.hue} size={18} />
            <span>{props.from.name}</span>
        </span>
        <span data-scope={SCOPE} data-part="chevron" role="img" aria-label="to"><Icon name="chevron-right" size={12} /></span>
        <span data-scope={SCOPE} data-part="to">
            <AgentTile name={props.to.name} hue={props.to.hue} size={18} />
            <span>{props.to.name}</span>
        </span>
        <span data-scope={SCOPE} data-part="task" title={props.task}>{props.task}</span>
        {props.itemRef && <span data-scope={SCOPE} data-part="ref">{props.itemRef}</span>}
    </div>
), { name: 'HandoffLine' });
