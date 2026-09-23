/**
 * `/plugins/gmail` over the real wire (#533): the plugin page of a conduit connector draws its sign-in panel — the
 * redirect URI with Copy, the account's status from the workspace's `ConnectorAccounts`, Connect / Reconnect /
 * Disconnect, what agents can do (AGT-09) and the "Testing" consent screen's 7-day note — and offers no field for
 * the engine secret it generates itself. The status follows the account live: an account whose refresh Google
 * refused (`needsReauth`) shows Reconnect.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { ConnectorAccounts, connectorAccountsKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, type PluginView, type StoredAccount } from '@agentic/platform';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { clientDefs } from '../../src/actors/client';
import { LiveConduitConnect } from '../../src/pages/plugins/ConduitConnect';
import { buttonNamed, text } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry, ConnectorAccounts] });
});
afterEach(async () => {
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const accounts = () => h.app.as(owner).actor(ConnectorAccounts, connectorAccountsKey(WS as WorkspaceId));
const panel = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-plugin-panel="connect"]');
const stateOf = (dom: ParentNode) => panel(dom)?.getAttribute('data-connection') ?? null;

const account = (status: StoredAccount['status']): StoredAccount => ({ id: 'acct_1', owner: WS, connector: 'gmail', method: 'oauth', status, credentials: 'sealed.NOT-A-TOKEN', displayName: 'owner@example.com', version: 1, createdAt: 1, updatedAt: 1 });

/** Gmail on, its OAuth client saved, one account on the record — what the sign-in routes leave behind. */
async function connected(status: StoredAccount['status']): Promise<void> {
    await registry().enable('gmail');
    await registry().setSecret('gmail-client-id', 'cid');
    await registry().setSecret('gmail-client-secret', 'cs');
    await accounts().createAccount(account(status));
    await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });
}

describe('/plugins/gmail (live)', () => {
    it('before anything is set up: the redirect URI, what is missing, what agents can do, the 7-day note — and no engine-secret field', async () => {
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => stateOf(dom) === 'not-connected', 'the panel');
        const p = panel(dom)!;
        expect(text(p.querySelector('[data-connect-redirect] code'))).toMatch(/\/_agentic\/connectors\/callback$/);
        expect(buttonNamed(p, 'Copy').disabled).toBe(false);
        expect(text(p)).toContain('NOT CONNECTED');
        expect(buttonNamed(p, 'Connect').disabled).toBe(true);
        expect(text(p.querySelector('[data-connect-blocker]'))).toBe('Turn Gmail on first (the switch above).');
        expect([...p.querySelectorAll('[data-operation]')].map((li) => li.getAttribute('data-operation'))).toEqual(['send-email', 'create-draft', 'reply-to-message', 'search-messages', 'get-message', 'get-thread', 'get-attachment', 'modify-labels', 'trash-message']);
        expect(text(p.querySelector('[data-connect-unsupported]'))).toBe('Not yet: New email (trigger).');
        expect(text(p.querySelector('[data-connect-testing]'))).toContain('expire after 7 days');
        // The owner's two keys have fields; the engine secret the platform generates does not.
        const fields = [...dom.querySelectorAll('[data-scope="ag-secret"][data-part="root"]')].map((f) => f.getAttribute('data-secret'));
        expect(fields).toEqual(['gmail-client-id', 'gmail-client-secret']);

        // On, then the client saved: Connect is offered without a reload.
        await registry().enable('gmail');
        await until(() => text(panel(dom)?.querySelector('[data-connect-blocker]')).startsWith('Save the OAuth client ID and OAuth client secret'), 'the missing keys');
        await registry().setSecret('gmail-client-id', 'cid');
        await registry().setSecret('gmail-client-secret', 'cs');
        await until(() => !panel(dom)?.querySelector('[data-connect-blocker]') && !buttonNamed(panel(dom)!, 'Connect').disabled, 'Connect enabled');
    }, 20_000);

    it('an account whose sign-in expired shows Reconnect; renewed, it shows who is connected', async () => {
        await connected('needsReauth');
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => stateOf(dom) === 'needs-reauth', 'the account status');
        const p = panel(dom)!;
        expect(text(p)).toContain('NEEDS RECONNECTING');
        expect(text(p.querySelector('[data-connect-text]'))).toContain('owner@example.com expired or was revoked');
        expect(buttonNamed(p, 'Reconnect').disabled).toBe(false);
        expect(buttonNamed(p, 'Disconnect').disabled).toBe(false);
        expect([...p.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Connect')).toBe(false);
        // Never a credential on the page.
        expect(dom.innerHTML).not.toContain('NOT-A-TOKEN');

        await accounts().updateAccount({ ...account('active'), version: 2 }, 1);
        await until(() => stateOf(dom) === 'active', 'the account to read active');
        expect(text(panel(dom)!.querySelector('[data-connect-text]'))).toContain('Connected as owner@example.com');
    }, 20_000);

    it('a failed sign-in says why when the routes send the owner back', async () => {
        const dom = await mountLive('/plugins/gmail?connect_error=authorization%20was%20not%20granted%3A%20access_denied', h);
        await until(() => !!panel(dom)?.querySelector('[role="alert"]'), 'the error');
        expect(text(panel(dom)!.querySelector('[role="alert"]'))).toBe('Connecting failed: authorization was not granted: access_denied');
    });

    it('Connect goes to the start route; Disconnect posts to the disconnect route', async () => {
        await connected('active');
        const plugin = (await registry().get('gmail')) as PluginView;
        const went: string[] = [];
        const posted: string[] = [];
        const dom = await mountLive('/plugins/gmail', h, (
            <LiveConduitConnect
                plugin={plugin}
                workspaceId={WS}
                secretNames={['gmail-client-id', 'gmail-client-secret']}
                hasKek
                defs={clientDefs()}
                navigate={(href: string) => { went.push(href); }}
                post={async (path: string) => { posted.push(path); return new Response(JSON.stringify({ disconnected: true, revoked: true }), { status: 200 }); }}
            />
        ));
        await until(() => stateOf(dom) === 'active', 'the account');
        buttonNamed(panel(dom)!, 'Reconnect').click();
        expect(went).toEqual(['/_agentic/connectors/gmail/start']);
        buttonNamed(panel(dom)!, 'Disconnect').click();
        await until(() => text(panel(dom)!.querySelector('[role="status"]')) === 'Disconnected.', 'the notice');
        expect(posted).toEqual(['/_agentic/connectors/gmail/disconnect']);
    });
});
