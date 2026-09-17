/**
 * `NeedsItem` — one "Needs you" inbox row (`docs/design/HANDOFF.md` →
 * "Components", Home). Tile 32, kind pill + title 14 / 600, a context
 * line, an action row. `kind` is the `data-kind` axis: approval, input or
 * interrupted. `compact` drops the context line (Session page, mobile).
 */
import { component, type Define } from '@sigx/runtime-core';
import { agNeedsItemAnatomy } from './anatomy.js';
import { StatusPill } from './StatusPill.js';
import type { NeedsKind } from './vocabulary.js';

const SCOPE = agNeedsItemAnatomy.scope;

export type NeedsItemProps =
    & Define.Prop<'kind', NeedsKind, true>
    & Define.Prop<'title', string, true>
    & Define.Prop<'compact', boolean>
    /** Relative age in the workspace zone, e.g. "2 min ago". */
    & Define.Prop<'age', string>
    & Define.Prop<'class', string>
    /** The `AgentTile` of who needs you. */
    & Define.Slot<'tile'>
    /** The context line: environment line, "delegated by Atlas", task ref… */
    & Define.Slot<'context'>
    /** The buttons — and, for an approval, the `ai-approval` card. */
    & Define.Slot<'default'>;

export const NeedsItem = component<NeedsItemProps>(({ props, slots }) => () => (
    <article data-scope={SCOPE} data-part="root" data-kind={props.kind} data-mod-compact={props.compact ? '' : undefined} class={props.class} aria-label={props.title}>
        <span data-scope={SCOPE} data-part="tile">{slots.tile?.()}</span>
        <div data-scope={SCOPE} data-part="head">
            <StatusPill status={props.kind} />
            <span data-scope={SCOPE} data-part="title" title={props.title}>{props.title}</span>
        </div>
        <p data-scope={SCOPE} data-part="context">
            {slots.context?.()}
            {props.age ? <span>· {props.age}</span> : null}
        </p>
        <div data-scope={SCOPE} data-part="actions">{slots.default?.()}</div>
    </article>
), { name: 'NeedsItem' });
