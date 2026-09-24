import { component, type Define } from 'sigx';

export type PluginsLayoutProps =
    /** The `?kind=` the page shows (`connector`, a plugin kind, or none for all). */
    & Define.Prop<'kind', string>
    & Define.Slot<'default'>
    /** The plugins menu (#637); empty until it lands, and then the content spans the grid. */
    & Define.Slot<'menu'>;

/**
 * The `/plugins` frame (#628): a plain two-column grid — the menu, then the
 * view `?kind=` picks. Without a menu the content is the only column, so the
 * page renders as it did before the redesign.
 */
export const PluginsLayout = component<PluginsLayoutProps>(({ props, slots }) => () => (
    <div data-plugins-layout data-kind={props.kind}>
        {slots.menu ? <nav data-plugins-menu aria-label="Plugins">{slots.menu()}</nav> : null}
        <div data-plugins-content>{slots.default?.()}</div>
    </div>
));
