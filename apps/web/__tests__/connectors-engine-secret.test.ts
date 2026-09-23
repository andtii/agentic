/**
 * The engine secret on production (#557): the connector routes call the Registry from the Worker, and a production
 * build masks every refusal that is not a `ServerFnError` to a bare "Internal error" — no `code`, no message. Whether
 * a secret is set must not hang on the refusal's shape.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ENGINE_SECRET } from '@agentic/connectors';
import { ensureEngineSecret, openPluginSecret, type ConnectorRegistry } from '../src/connectors/engine';

/** A Registry as the Worker sees it on production: every refusal arrives as a masked 500. */
function maskedRegistry(initial: Record<string, string> = {}, options: { disabled?: boolean } = {}) {
    const values = new Map(Object.entries(initial));
    const masked = (): Error => new Error('Internal error');
    const registry: Pick<ConnectorRegistry, 'openSecret' | 'setSecret' | 'secrets'> = {
        async secrets() {
            return [...values.keys()].sort().map((name) => ({ name, updatedAt: 1 }));
        },
        async openSecret(name) {
            if (options.disabled) throw masked();
            const value = values.get(name);
            if (value === undefined) throw masked();
            return value;
        },
        async setSecret(name, value) {
            values.set(name, value);
            return { name, updatedAt: 1 };
        }
    };
    return { registry, values };
}

describe('connector secrets behind a masked Registry (#557)', () => {
    it('generates the engine secret on the first Connect even though the refusal carries no code', async () => {
        const { registry, values } = maskedRegistry();
        const secret = await ensureEngineSecret(registry, 'gmail');
        expect(secret.length).toBeGreaterThanOrEqual(32);
        expect(values.get(CONNECTOR_ENGINE_SECRET)).toBe(secret);
        // The second Connect reads it back instead of generating another.
        expect(await ensureEngineSecret(registry, 'gmail')).toBe(secret);
    });

    it('reads a secret that is not set as undefined, and one that is set as its value', async () => {
        const { registry } = maskedRegistry({ 'gmail-client-id': 'cid' });
        expect(await openPluginSecret(registry, 'gmail-client-secret', 'gmail')).toBeUndefined();
        expect(await openPluginSecret(registry, 'gmail-client-id', 'gmail')).toBe('cid');
    });

    it('still fails a set secret the plugin may not open (turned off, not granted)', async () => {
        const { registry } = maskedRegistry({ [CONNECTOR_ENGINE_SECRET]: 'x'.repeat(43) }, { disabled: true });
        await expect(openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, 'gmail')).rejects.toThrow('Internal error');
        await expect(ensureEngineSecret(registry, 'gmail')).rejects.toThrow('Internal error');
    });
});
