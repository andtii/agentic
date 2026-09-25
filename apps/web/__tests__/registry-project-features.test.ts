/**
 * The app wires the build's project feature plugins into the Registry (#773): `projectFeatures()` lists each
 * feature's presets from its code half — the same map Routing takes — instead of `presets: []`.
 */
import { registryKey, type RegistryActor } from '@agentic/platform';
import { projectFeatureCatalogue } from '../src/plugins/features';
import { startHost, type AcceptanceHost } from './acceptance/host';

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('Registry.projectFeatures() in the app (#773)', () => {
    it('lists every built-in feature with the presets its plugin declares', async () => {
        const me = h.user('u773');
        const registry = h.as(me.principal).actor(h.Registry as RegistryActor, registryKey(me.ws));
        const features = await registry.projectFeatures();
        const withPresets = Object.entries(projectFeatureCatalogue).filter(([, p]) => (p.presets?.length ?? 0) > 0);
        expect(withPresets.length).toBeGreaterThan(0);
        for (const [id, plugin] of withPresets) {
            const view = features.find((f) => f.id === id);
            expect(view, id).toBeDefined();
            expect(view!.presets).toEqual(plugin.presets);
        }
    });
});
