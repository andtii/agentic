/**
 * `PluginCard` — one plugin of the build as the user must be able to see it
 * (PLG-02, PLG-03): name + version, kind, what it does, and whether it can
 * be used right now. Drawn to `docs/design/HANDOFF.md` → Plugins `/plugins`
 * (three-column cards, the enable switch in the header, dependents and the
 * configure link in the footer).
 *
 * The card holds no behaviour: the enable switch, the dependents and the
 * configure link are slots, so the page owns the Registry calls. A disabled
 * plugin dims (`tone: dim`); one that needs the user paints its border
 * (`needs-you`, `failed`); the active plugin of a single-slot kind (memory,
 * learning) carries the ACTIVE tag and the `selected` border.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PluginKind, PluginReadiness } from '@agentic/core';
import { agPluginCardAnatomy } from '../kit/anatomy.js';
import { Tag } from '../kit/StatusPill.js';
import { ReadinessBadge } from './ReadinessBadge.js';
import { READINESS } from './readiness.js';

const SCOPE = agPluginCardAnatomy.scope;

export type PluginCardProps =
    /** The plugin id — stamped as `data-plugin` for the page and its tests. */
    & Define.Prop<'id', string>
    & Define.Prop<'name', string, true>
    & Define.Prop<'kind', PluginKind, true>
    /** The kind tag's text when it says more than the kind (`harness runtime`, #313); the kind by default. */
    & Define.Prop<'kindLabel', string>
    /** Extra tags for what it does beyond its kind (`usage limits`). */
    & Define.Prop<'features', readonly string[]>
    & Define.Prop<'version', string>
    & Define.Prop<'description', string>
    & Define.Prop<'readiness', PluginReadiness>
    /** The workspace's active plugin of a single-slot kind (`isSingleSlot`). */
    & Define.Prop<'active', boolean>
    & Define.Prop<'class', string>
    /** The enable switch (top right). */
    & Define.Slot<'toggle'>
    /** Sections under the description: granted permissions, a notice. */
    & Define.Slot<'default'>
    /** Footer, left: who depends on it. */
    & Define.Slot<'meta'>
    /** Footer, right: the link to its page. */
    & Define.Slot<'configure'>;

export const PluginCard = component<PluginCardProps>(({ props, slots }) => () => {
    const readiness = props.readiness;
    const spec = readiness ? READINESS[readiness.status] : undefined;
    // A ready plugin is the quiet case: only what needs the user, or is off, paints the card.
    const tone = spec && readiness!.status !== 'ready' ? spec.tone : undefined;
    const meta = slots.meta?.();
    const configure = slots.configure?.();
    return (
        <article data-scope={SCOPE} data-part="root" data-plugin={props.id} data-kind-of={props.kind} data-tone={tone} data-mod-selected={props.active ? '' : undefined} aria-label={props.name} class={props.class}>
            <header data-scope={SCOPE} data-part="header">
                <h3 data-scope={SCOPE} data-part="name">
                    <span>{props.name}</span>
                    {props.version ? <span data-scope={SCOPE} data-part="version">{props.version}</span> : null}
                </h3>
                {slots.toggle?.()}
            </header>
            <div data-scope={SCOPE} data-part="tags">
                <Tag>{props.kindLabel ?? props.kind}</Tag>
                {props.features?.map((f) => <Tag key={f} tone="live">{f}</Tag>)}
                {props.active ? <Tag tone="live">active</Tag> : null}
                {readiness ? <ReadinessBadge readiness={readiness} /> : null}
            </div>
            {props.description ? <p data-scope={SCOPE} data-part="description">{props.description}</p> : null}
            {slots.default?.()}
            {meta || configure ? (
                <footer data-scope={SCOPE} data-part="footer">
                    <span data-scope={SCOPE} data-part="meta">{meta}</span>
                    {configure}
                </footer>
            ) : null}
        </article>
    );
}, { name: 'PluginCard' });
