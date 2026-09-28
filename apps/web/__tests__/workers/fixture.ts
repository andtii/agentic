// The test wiring BOTH hosts run the acceptance suite with (#995): the Worker (`./worker.ts`, inside workerd) and
// the Node host (`../node/cloudflare-test.ts`, `pnpm --filter @agentic/web test:node`). Only these seams differ
// from production; every other port is the host's real wiring.
//
// The `anthropic-api` runtime is a mock agent (#34): the chat test drives a post through activation, routing and
// a session, offline. Since #231 it sits behind the production session factory and Registry: the router gates the
// run on the plugin, and the runtime opens only with the workspace's `anthropic-api-key` secret (sealed under the
// host's `WORKSPACE_KEK`), as `anthropicApiRuntime` does — so a test that expects an answer sets the key first
// (`setAnthropicKey`).
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_API_PLUGIN_ID, CLAUDE_CODE_PLUGIN_ID } from '@agentic/runtimes';
import { NO_API_KEY_CODE, type RuntimeCatalogue } from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import type { PlatformPorts } from '../../src/platform.app';
import { createConnectorMount } from '../../src/connectors/routes';
import { conduitConnectorCatalogue } from '../../src/plugins/catalogue';
import { conduitCall, fakeGoogle } from './google';
import { workerPullSources } from './pulls-source';

const agent = mockAgent({ respond: (input) => [{ text: `echo: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });

const runtimes: RuntimeCatalogue = {
    [ANTHROPIC_API_PLUGIN_ID]: {
        host: 'local',
        async open(c, plugin) {
            // The key check `anthropicApiRuntime` makes, against the real Registry; only the model is the mock.
            if (!(await plugin.secret(ANTHROPIC_API_KEY_SECRET))) throw new Error(`${NO_API_KEY_CODE}: workspace ${c.workspaceId} has no Anthropic API key — add one at /plugins/${ANTHROPIC_API_PLUGIN_ID}`);
            const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
            return { session, agentId: agent.id, capabilities: agent.capabilities };
        }
    },
    [CLAUDE_CODE_PLUGIN_ID]: { host: 'daemon' }
};

/**
 * Connector sign-in (#533) and the connector trigger (#535) run over a fake Google (`./google.ts`): the token,
 * revoke, profile and message endpoints answer in-process, so start → consent → callback → tool call, and a
 * schedule's poll, run offline.
 */
export const google = fakeGoogle();

/**
 * The ports a test host overrides, over the host's own registry (`actors`, read at call time): the mock runtime,
 * the fake Google, no daemon release manifest (offline, #365), and pull requests from a scripted fake (#742).
 */
export function testPorts(actors: () => readonly AnyActorDefinition[]): Partial<PlatformPorts> {
    return { runtimes, connectorHttp: google.http, releasesFetch: async () => new Response('offline', { status: 404 }), pulls: workerPullSources(actors) };
}

/** Connector sign-in (#533), as the production entry mounts it, over the fake Google above. */
export const connectorsRoute = createConnectorMount({ connectors: conduitConnectorCatalogue, http: google.http });

/** Test-only routes, ahead of every production route: what the fake Google saw, and one conduit tool call the way a session makes it (`./google.ts`). */
export function testRoute(request: Request): ((request: Request) => Promise<Response>) | undefined {
    return google.route(request) ?? conduitCall(request, google.http);
}
