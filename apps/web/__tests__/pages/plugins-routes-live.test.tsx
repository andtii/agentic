/**
 * `/plugins?kind=connector` over the real wire (#628): on the platform the
 * Connectors view draws the workspace's MCP servers (`LiveConnectorsView`) inside
 * the plugins layout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineRegistry, generateWorkspaceKek, importWorkspaceKek } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { buttonNamed } from './helpers';
import { mountLive, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...RUNTIME_PLUGINS] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
});
afterEach(async () => {
    await h.stop();
});

describe('plugins routes (#628, live)', () => {
    it('?kind=connector renders LiveConnectorsView inside the plugins layout', async () => {
        const dom = await mountLive('/plugins?kind=connector', h);
        const connectors = () => dom.querySelector('[data-plugins-layout][data-kind="connector"] [data-plugins-content] [data-plugin-connectors]');
        await until(() => connectors() !== null, 'the connector list');
        expect(buttonNamed(connectors()!, 'Add MCP server')).not.toBeNull();
    });
});
