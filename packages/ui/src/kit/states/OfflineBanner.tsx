/**
 * `OfflineBanner` on the `ag-banner` scope — the "This browser is offline"
 * strip over the content (`docs/design/HANDOFF.md` → "Failure
 * distinction" row 1): muted, no action, "Reconnecting…" as the state. The
 * connection strip shows the same signal in the sidebar; this is the half a
 * reader sees without looking down. `tone` is open so a page can raise an
 * amber banner for a disconnected machine with the same anatomy.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agBannerAnatomy } from '../anatomy.js';
import { Icon, type IconName } from '../icons.js';
import type { Tone } from '../vocabulary.js';

const SCOPE = agBannerAnatomy.scope;

export type OfflineBannerProps =
    & Define.Prop<'message', string>
    & Define.Prop<'state', string>
    & Define.Prop<'tone', Tone>
    & Define.Prop<'icon', IconName>
    & Define.Prop<'class', string>
    /** An action at the end (a machine banner's "Open machine"); the offline banner has none. */
    & Define.Slot<'default'>;

export const OfflineBanner = component<OfflineBannerProps>(({ props, slots }) => () => (
    <div data-scope={SCOPE} data-part="root" data-tone={props.tone ?? 'muted'} role="status" aria-live="polite" class={props.class}>
        <span data-scope={SCOPE} data-part="icon"><Icon name={props.icon ?? 'wifi'} size={15} /></span>
        <span data-scope={SCOPE} data-part="text">{props.message ?? 'This browser is offline'}</span>
        <span data-scope={SCOPE} data-part="state">{props.state ?? 'Reconnecting…'}</span>
        {slots.default ? <span data-scope={SCOPE} data-part="actions">{slots.default()}</span> : null}
    </div>
), { name: 'OfflineBanner' });
