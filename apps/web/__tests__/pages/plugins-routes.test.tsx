/**
 * The plugins redesign's scaffold (#628): `/plugins` picks its view by
 * `?kind=` inside the plugins layout, `/plugins/connectors/add` is its own
 * route ahead of `/plugins/:id`, and its breadcrumb is Plugins › Connectors ›
 * Add connector. Nothing here changes what `/plugins` or a plugin draws.
 */
import { trailFor } from '../../src/crumbs';
import { createServerRouter } from '../../src/router';
import { mountRoute, page } from './mount';

describe('plugins routes (#628)', () => {
    it('/plugins renders the catalogue inside the plugins layout, with no menu yet', async () => {
        const root = await mountRoute('/plugins');
        const layout = root.querySelector('[data-plugins-layout]')!;
        expect(layout).not.toBeNull();
        expect(layout.querySelector('[data-plugins-menu]')).toBeNull();
        expect(layout.querySelector('[data-plugins-content] [data-page="plugins"] [data-plugin-catalogue]')).not.toBeNull();
    });

    it('?kind=connector renders the Connectors view in the layout', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        expect(root.querySelector('[data-plugins-layout]')!.getAttribute('data-kind')).toBe('connector');
        // On mock data the stub draws today's catalogue.
        expect(page(root, 'plugins')).not.toBeNull();
    });

    it('/plugins/connectors/add renders the stub, not a plugin called "connectors"', async () => {
        const router = createServerRouter('/plugins/connectors/add');
        await router.isReady();
        expect(router.currentRoute.name).toBe('connector-add');

        const root = await mountRoute('/plugins/connectors/add');
        const stub = page(root, 'connector-add')!;
        expect(stub.getAttribute('aria-label')).toBe('Add a connector');
        expect(root.textContent).not.toContain('No plugin with id');
    });

    it('/plugins/gmail still renders the plugin page', async () => {
        const root = await mountRoute('/plugins/gmail');
        expect(root.querySelector('[data-plugin-detail]')!.getAttribute('data-plugin')).toBe('gmail');
    });

    it('the add page\'s breadcrumb is Plugins › Connectors › Add connector', () => {
        const trail = trailFor({ name: 'connector-add', path: '/plugins/connectors/add', params: {} }, undefined);
        expect(trail).toEqual([
            { label: 'Plugins', href: '/plugins' },
            { label: 'Connectors', href: '/plugins?kind=connector' },
            { label: 'Add connector', href: '/plugins/connectors/add', current: true }
        ]);
    });
});
