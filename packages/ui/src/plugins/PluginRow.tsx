/**
 * `PluginRow` — one plugin as a compact row of a catalogue group
 * (`docs/design/plugins/HANDOFF-plugins.md` → "All plugins", "Connectors";
 * boards `Plugins`, `PluginsConnectors`). A 60 px grid
 * `36px 1fr 150px 150px 120px 44px 20px`: the tile, name + version + feature
 * tags over a one-line description, the kind tag, the readiness pill with an
 * optional fix button, the dependents, the switch and the chevron.
 *
 * - `href` makes the whole row a link. The `toggle`, `fix` and `action`
 *   slots stop the click and keydown from reaching the row, so a router
 *   listening above never navigates on them. Pass buttons there, never links
 *   (an `<a>` cannot hold another `<a>`).
 * - `variant: 'connector'` is the Connectors view: grid
 *   `36px 1fr 90px 230px 100px 44px 20px`, 56 px, the description is the mono
 *   account line and `kind` the transport.
 * - `variant: 'radio'` is a single-slot kind (memory, learning): a leading
 *   radio dot, and on the right the ACTIVE pill when `active`, else the
 *   `action` slot (`Make active`). `consequence` is the mono line under the
 *   description that says what switching drops.
 *
 * Data in, slots out: the page owns the Registry calls.
 */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import type { PluginReadiness } from '@agentic/core';
import { AgentTile } from '../kit/AgentTile.js';
import { Icon } from '../kit/icons.js';
import { StatusPill, Tag } from '../kit/StatusPill.js';
import { ReadinessBadge } from './ReadinessBadge.js';

export type PluginRowVariant = 'default' | 'connector' | 'radio';

export type PluginRowProps =
    /** The plugin id, stamped as `data-plugin`. */
    & Define.Prop<'id', string>
    & Define.Prop<'name', string, true>
    & Define.Prop<'version', string>
    /** Tags after the version for what it does beyond its kind (`usage limits`). */
    & Define.Prop<'features', readonly string[]>
    /** The one-line description; the account or endpoint line for a connector. */
    & Define.Prop<'description', string>
    /** The kind tag's text (`harness`, `model`); the transport for a connector (`conduit`, `mcp`). */
    & Define.Prop<'kind', string>
    /** Override the tile's two letters (derived from `name`). */
    & Define.Prop<'monogram', string>
    & Define.Prop<'readiness', PluginReadiness>
    & Define.Prop<'href', string>
    & Define.Prop<'variant', PluginRowVariant>
    /** `radio`: this is the workspace's active plugin of its kind. */
    & Define.Prop<'active', boolean>
    /** `radio`: what making it active drops, in mono under the description. */
    & Define.Prop<'consequence', string>
    & Define.Prop<'class', string>
    /** Replaces the monogram tile. */
    & Define.Slot<'tile'>
    /** The fix button beside the readiness pill (`Sign in`, `Add key`). */
    & Define.Slot<'fix'>
    /** Who depends on it: agent tiles, "Used by 1 project", "No dependents". */
    & Define.Slot<'dependents'>
    /** The enable switch. */
    & Define.Slot<'toggle'>
    /** `radio`: shown instead of the ACTIVE pill (`Make active`). */
    & Define.Slot<'action'>;

const COLUMNS: Record<PluginRowVariant, string> = {
    default: '36px minmax(0, 1fr) 150px 150px 120px 44px 20px',
    connector: '36px minmax(0, 1fr) 90px 230px 100px 44px 20px',
    radio: '16px 36px minmax(0, 1fr) auto 20px'
};

const dimLine = 'font-size: var(--text-sm); color: var(--ag-text-dim)';
const monoLine = 'font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ag-text-dim)';
const oneLine = '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis';
const cell = 'display: flex; align-items: center; gap: var(--space-sm); min-inline-size: 0';

/** Keeps a control's click and keydown inside its slot: the row link never sees them. */
const stop = (e: Event): void => e.stopPropagation();

/**
 * A click on the slot's own empty space (not a control inside it) would still
 * follow the row link, since `stopPropagation` does not cancel the default
 * action: cancel it there, and leave clicks on the controls untouched.
 */
const stopClick = (e: Event): void => {
    e.stopPropagation();
    if (e.target === e.currentTarget) e.preventDefault();
};

function slotCell(part: string, content: JSXElement | JSXElement[] | undefined, style = cell): JSXElement {
    return <span data-plugin-row-part={part} style={style} onClick={stopClick} onKeydown={stop}>{content}</span>;
}

export const PluginRow = component<PluginRowProps>(({ props, slots }) => () => {
    const variant = props.variant ?? 'default';
    const radio = variant === 'radio';
    const connector = variant === 'connector';
    const style = `display: grid; grid-template-columns: ${COLUMNS[variant]}; column-gap: 14px; align-items: center; min-block-size: ${connector ? 56 : 60}px; box-sizing: border-box; padding: var(--space-sm) var(--space-lg); border-block-end: var(--border) solid var(--ag-line); color: var(--color-base-content); text-decoration: none`;
    const body = [
        radio ? (
            <span data-plugin-row-part="radio" aria-hidden="true" style={`display: grid; place-items: center; inline-size: 16px; block-size: 16px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid ${props.active ? 'var(--color-primary)' : 'var(--ag-line-strong)'}`}>
                {props.active ? <span style="inline-size: 8px; block-size: 8px; border-radius: 50%; background: var(--color-primary)" /> : null}
            </span>
        ) : null,
        <span data-plugin-row-part="tile" style="display: flex">{slots.tile ? slots.tile() : <AgentTile name={props.name} monogram={props.monogram} size={32} />}</span>,
        <span data-plugin-row-part="title" style="display: flex; flex-direction: column; gap: var(--space-2xs); min-inline-size: 0">
            <span style={cell}>
                <span data-plugin-row-part="name" style={`font-size: var(--text-md); font-weight: var(--weight-semibold)${oneLine}`}>{props.name}</span>
                {props.version ? <span data-plugin-row-part="version" style={monoLine}>{props.version}</span> : null}
                {props.features?.map((f) => <Tag key={f} tone="working">{f}</Tag>)}
            </span>
            {props.description ? <span data-plugin-row-part="description" style={(connector ? monoLine : dimLine) + oneLine}>{props.description}</span> : null}
            {radio && props.consequence ? <span data-plugin-row-part="consequence" style={monoLine}>{props.consequence}</span> : null}
        </span>,
        ...(radio
            ? [props.active ? <StatusPill status="active" label="ACTIVE" tone="live" /> : slotCell('action', slots.action?.())]
            : [
                <span data-plugin-row-part="kind" style={cell}>{props.kind ? <Tag>{props.kind}</Tag> : null}</span>,
                <span data-plugin-row-part="readiness" style={cell}>
                    {props.readiness ? <ReadinessBadge readiness={props.readiness} /> : null}
                    {slots.fix ? slotCell('fix', slots.fix()) : null}
                </span>,
                <span data-plugin-row-part="dependents" style={`${cell}; gap: var(--space-2xs); font-size: var(--text-xs); color: var(--ag-text-dim)`}>{slots.dependents?.()}</span>,
                slotCell('toggle', slots.toggle?.())
            ]),
        <span data-plugin-row-part="chevron" style="display: flex; color: var(--ag-text-dim)">{props.href ? <Icon name="chevron-right" size={14} /> : null}</span>
    ];
    const common = { 'data-plugin-row': variant, 'data-plugin': props.id, 'data-readiness': props.readiness?.status, 'data-active': props.active ? '' : undefined, class: props.class, style };
    return props.href ? <a href={props.href} {...common}>{body}</a> : <div {...common}>{body}</div>;
}, { name: 'PluginRow' });
