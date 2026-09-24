/**
 * `ConnectorTile` — one installable connector on the Add a connector page
 * (`docs/design/plugins/HANDOFF-plugins.md` → "Add a connector", board
 * `AddConnector`): the monogram, the name, the transport in mono caps and a
 * one-line description, in a 120 px `<button aria-pressed>`.
 *
 * - `selected`: `base-300` fill and the `live` border at 53 %; it is the one
 *   the preview shows (`aria-pressed="true"`).
 * - `connected`: dimmed, with a `Connected` check. The page opens its plugin
 *   page on `select` instead of the preview.
 */
import { component, type Define } from '@sigx/runtime-core';
import { AgentTile } from '../kit/AgentTile.js';
import { Icon } from '../kit/icons.js';

export type ConnectorTileProps =
    /** The connector id, stamped as `data-connector`. */
    & Define.Prop<'id', string>
    & Define.Prop<'name', string, true>
    /** `conduit`, `mcp`, `mcp stdio`; shown in mono caps. */
    & Define.Prop<'transport', string>
    & Define.Prop<'description', string>
    & Define.Prop<'monogram', string>
    & Define.Prop<'selected', boolean>
    & Define.Prop<'connected', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'select', void>;

export const ConnectorTile = component<ConnectorTileProps>(({ props, emit }) => () => {
    const selected = !!props.selected;
    const connected = !!props.connected;
    const style = `display: flex; flex-direction: column; gap: 10px; min-block-size: 120px; box-sizing: border-box; padding: 14px; text-align: start; font: inherit; cursor: pointer; border-radius: var(--radius-box); --ag-edge: ${selected ? 'color-mix(in oklab, var(--color-primary) 53%, transparent)' : 'var(--ag-line)'}; border: var(--border) solid var(--ag-edge); background: ${selected ? 'var(--color-base-300)' : 'var(--color-base-200)'}; color: ${connected ? 'var(--ag-text-muted)' : 'var(--color-base-content)'}`;
    return (
        <button type="button" aria-pressed={selected ? 'true' : 'false'} data-connector={props.id} data-selected={selected ? '' : undefined} data-connected={connected ? '' : undefined} class={props.class} style={style} onClick={() => emit('select')}>
            <span style="display: flex; align-items: center; gap: 10px; min-inline-size: 0">
                <AgentTile name={props.name} monogram={props.monogram} size={32} />
                <span style="display: flex; flex-direction: column; gap: 1px; min-inline-size: 0">
                    <span data-connector-part="name" style="font-size: var(--text-md); font-weight: var(--weight-semibold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{props.name}</span>
                    {props.transport ? <span data-connector-part="transport" style="font-family: var(--font-mono); font-size: 10px; font-weight: var(--weight-medium); letter-spacing: var(--tracking-wide); text-transform: uppercase; color: var(--ag-text-dim)">{props.transport}</span> : null}
                </span>
            </span>
            {props.description ? <span data-connector-part="description" style="flex-grow: 1; font-size: var(--text-sm); color: var(--ag-text-dim); text-wrap: pretty">{props.description}</span> : null}
            {connected ? (
                <span data-connector-part="connected" style="display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-primary)">
                    <Icon name="check" size={13} />
                    Connected
                </span>
            ) : null}
        </button>
    );
}, { name: 'ConnectorTile' });
