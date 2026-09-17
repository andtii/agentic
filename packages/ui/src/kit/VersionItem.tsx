/**
 * `VersionItem` — one config version in the versions rail (`docs/design/
 * HANDOFF.md` → "Components", Agent config). `current` is the live one;
 * `proposed` (from learning) carries a NEEDS REVIEW pill and Review /
 * Dismiss; `past` offers "Roll back to vN". Every action is an event, so
 * the page decides what a roll-back does (AGT-06).
 */
import { component, type Define } from '@sigx/runtime-core';
import type { AgentConfigVersion } from '@agentic/core';
import { agVersionAnatomy } from './anatomy.js';
import { Button } from './Button.js';
import { StatusPill } from './StatusPill.js';

const SCOPE = agVersionAnatomy.scope;

export type VersionState = 'current' | 'proposed' | 'past';

export type VersionItemProps =
    & Define.Prop<'version', AgentConfigVersion, true>
    & Define.Prop<'state', VersionState, true>
    /** The version's date, formatted in the workspace zone. */
    & Define.Prop<'when', string>
    & Define.Prop<'class', string>
    & Define.Event<'review', number>
    & Define.Event<'dismiss', number>
    & Define.Event<'rollback', number>;

export const VersionItem = component<VersionItemProps>(({ props, emit }) => () => {
    const v = props.version;
    return (
        <li data-scope={SCOPE} data-part="root" data-version={v.version} data-tone={props.state === 'proposed' ? 'needs-you' : undefined} data-mod-current={props.state === 'current' ? '' : undefined} class={props.class}>
            <div data-scope={SCOPE} data-part="head">
                <span>v{v.version}</span>
                {props.state === 'current' ? <StatusPill status="current" label="CURRENT" tone="live" /> : null}
                {props.state === 'proposed' ? <StatusPill status="needs-review" /> : null}
            </div>
            <span data-scope={SCOPE} data-part="meta">{props.when ?? new Date(v.at).toISOString()} · {v.by}</span>
            <p data-scope={SCOPE} data-part="reason">{v.reason}</p>
            {props.state === 'proposed' ? (
                <div data-scope={SCOPE} data-part="actions">
                    <Button intent="primary" onClick={() => emit('review', v.version)}>Review</Button>
                    <Button onClick={() => emit('dismiss', v.version)}>Dismiss</Button>
                </div>
            ) : null}
            {props.state === 'past' ? (
                <div data-scope={SCOPE} data-part="actions">
                    <Button onClick={() => emit('rollback', v.version)}>Roll back to v{v.version}</Button>
                </div>
            ) : null}
        </li>
    );
}, { name: 'VersionItem' });
