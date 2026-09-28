/**
 * `FoldedTalk` — agent-to-agent talk folded into a centred divider (`ai-folded-talk`, #1057;
 * `docs/design/chat-modes/HANDOFF.md` → "Team"): `Forge and Lint exchanged 4 messages · show`.
 * The button asks `onToggle` for the other state; the view expands the talk in place.
 */
import { component, type Define } from '@sigx/runtime-core';
import { aiFoldedTalkAnatomy } from './anatomy.js';
import { formatFoldedTalk } from './model.js';

const SCOPE = aiFoldedTalkAnatomy.scope;

export type FoldedTalkProps =
    /** Who talked, in order of first message. */
    & Define.Prop<'names', readonly string[], true>
    & Define.Prop<'count', number, true>
    /** The talk is shown: the button reads `hide`. */
    & Define.Prop<'open', boolean, false>
    & Define.Prop<'onToggle', (open: boolean) => void, false>;

export const FoldedTalk = component<FoldedTalkProps>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="root">
        <span data-scope={SCOPE} data-part="label">{formatFoldedTalk(props.names, props.count)} ·</span>
        <button type="button" data-scope={SCOPE} data-part="show" aria-expanded={props.open ? 'true' : 'false'} onClick={() => props.onToggle?.(!props.open)}>
            {props.open ? 'hide' : 'show'}
        </button>
    </div>
), { name: 'FoldedTalk' });
