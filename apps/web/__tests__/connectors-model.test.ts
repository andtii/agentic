/**
 * The pure halves of connecting Gmail (#533): the sign-in routes' redirect guards and the connector page's model.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ENGINE_SECRET, gmailConnectorPlugin } from '@agentic/connectors';
import type { ConnectorAccountSummary, PluginView } from '@agentic/platform';
import { newEngineSecret } from '../src/connectors/engine';
import { CONNECTOR_ENGINE_SECRET_NAME, connectorRedirectUri } from '../src/connectors/paths';
import { sameSitePath, unverifiedReturnTo, withParam } from '../src/connectors/routes';
import { connectBlocker, connectionOf, connectOutcome, isConduitConnector, managedSecretsOf, operationsOf, ownerSecretsOf, unsupportedOf } from '../src/pages/plugins/conduit';
import { connectorWhere } from '../src/pages/ops/live';
import { HISTORY_KIND_FILTERS, kindLabel, refOf, toneOf } from '../src/pages/history/live';
import type { AuditEvent } from '@agentic/platform';

const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const view = (over: Partial<PluginView> = {}): PluginView => ({ manifest: gmailConnectorPlugin, enabled: true, config: {}, grantedPermissions: gmailConnectorPlugin.permissions.map((p) => p.scope), registeredAt: 0, updatedAt: 0, builtin: true, ...over });
const summary = (status: ConnectorAccountSummary['status']): ConnectorAccountSummary => ({ id: 'acct_1', connector: 'gmail', method: 'oauth', status, displayName: 'owner@example.com', createdAt: 1, updatedAt: 1 });

describe('the sign-in routes: where the owner is sent back', () => {
    it('only a same-site path', () => {
        expect(sameSitePath('/plugins/gmail')).toBe('/plugins/gmail');
        expect(sameSitePath('/plugins/gmail?x=1')).toBe('/plugins/gmail?x=1');
        for (const bad of ['https://evil.test/', '//evil.test/', '/\\evil.test', 'plugins/gmail', '', undefined, 42]) expect(sameSitePath(bad), String(bad)).toBeUndefined();
    });

    it('sets one query parameter, percent-encoded, over any earlier copy', () => {
        expect(withParam('/plugins/gmail', 'connect_error', 'a b+c')).toBe('/plugins/gmail?connect_error=a%20b%2Bc');
        expect(withParam('/plugins/gmail?connected=1&x=y z', 'connected', '1')).toBe('/plugins/gmail?x=y%20z&connected=1');
    });

    it('reads returnTo off a conduit state without trusting it for anything but a same-site path', () => {
        expect(unverifiedReturnTo(`${b64url(JSON.stringify({ n: 'x', r: '/plugins/gmail' }))}.sig`)).toBe('/plugins/gmail');
        expect(unverifiedReturnTo(`${b64url(JSON.stringify({ r: 'https://evil.test' }))}.sig`)).toBeUndefined();
        expect(unverifiedReturnTo('garbage')).toBeUndefined();
        // Unpadded base64url of any length decodes; an oversized payload is not decoded at all.
        expect(unverifiedReturnTo(`${b64url(JSON.stringify({ r: '/plugins/gmail', pad: 'x' }))}.sig`)).toBe('/plugins/gmail');
        expect(unverifiedReturnTo(`${b64url(JSON.stringify({ r: '/plugins/gmail', junk: 'x'.repeat(3000) }))}.sig`)).toBeUndefined();
        expect(unverifiedReturnTo(null)).toBeUndefined();
    });

    it('the engine secret is random, URL-safe and long enough for conduit; the redirect URI is the callback on the origin', () => {
        const a = newEngineSecret();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(newEngineSecret()).not.toBe(a);
        expect(connectorRedirectUri('https://agentic.example/')).toBe('https://agentic.example/_agentic/connectors/callback');
        expect(CONNECTOR_ENGINE_SECRET_NAME).toBe(CONNECTOR_ENGINE_SECRET);
    });
});

describe("a conduit connector's page model", () => {
    it('knows a conduit connector by its engine secret, and offers fields for the OAuth client only', () => {
        expect(isConduitConnector(gmailConnectorPlugin)).toBe(true);
        expect(managedSecretsOf(gmailConnectorPlugin)).toEqual([CONNECTOR_ENGINE_SECRET]);
        expect(ownerSecretsOf(gmailConnectorPlugin)).toEqual(['client-id', 'client-secret']);
    });

    it('reads the account status off the record and the summaries', () => {
        expect(connectionOf(undefined, undefined)).toEqual({ state: 'not-connected' });
        expect(connectionOf({ transport: 'conduit' }, [])).toEqual({ state: 'not-connected' });
        expect(connectionOf({ transport: 'conduit', account: 'acct_1' }, undefined)).toBeUndefined();
        expect(connectionOf({ transport: 'conduit', account: 'acct_1' }, [summary('active')])).toMatchObject({ state: 'active' });
        expect(connectionOf({ transport: 'conduit', account: 'acct_1' }, [summary('needsReauth')])).toMatchObject({ state: 'needs-reauth' });
        expect(connectionOf({ transport: 'conduit', account: 'acct_gone' }, [summary('active')])).toEqual({ state: 'missing', accountId: 'acct_gone' });
    });

    it('says what Connect still needs', () => {
        expect(connectBlocker(view(), ['client-id', 'client-secret'], false)).toMatch(/WORKSPACE_KEK/);
        expect(connectBlocker(view({ enabled: false }), ['client-id', 'client-secret'], true)).toBe('Turn Gmail on first (the switch above).');
        expect(connectBlocker(view(), ['client-id'], true)).toBe('Save the OAuth client secret above first.');
        // The engine secret is generated on Connect, never asked for.
        expect(connectBlocker(view(), ['client-id', 'client-secret'], true)).toBeUndefined();
    });

    it('lists what agents can do (AGT-09) and what is not supported yet', () => {
        expect(operationsOf(gmailConnectorPlugin).map((o) => o.label)).toEqual(['Send email', 'Create draft', 'Reply to message', 'Search messages', 'Get message', 'Get thread', 'Get attachment', 'Modify labels', 'Trash message']);
        // The new-email trigger runs by polling (#535): nothing is left unsupported.
        expect(unsupportedOf(gmailConnectorPlugin)).toEqual([]);
    });

    it('reads what the routes said on the way back', () => {
        expect(connectOutcome({ connected: '1' })).toEqual({ connected: true });
        expect(connectOutcome({ connect_error: 'nope' })).toEqual({ connected: false, error: 'nope' });
        expect(connectOutcome({})).toEqual({ connected: false });
    });

    it('a conduit connector runs on the platform, not over stdio', () => {
        const record = { id: 'gmail', pluginId: 'gmail', transport: 'conduit' as const, connector: 'gmail', tools: [], status: { state: 'unknown' as const }, updatedAt: 0 };
        expect(connectorWhere(record)).toBe('gmail on the platform · not connected');
        expect(connectorWhere({ ...record, account: 'acct_1' })).toBe('gmail on the platform');
    });
});

describe('connected accounts in /history', () => {
    const event = (kind: 'connector.connected' | 'connector.needs-reauth' | 'connector.disconnected', reconnected?: boolean) =>
        ({ key: 'k', seq: 1, kind, at: 1, by: 'user:u1', summary: 'gmail account owner@example.com', data: { accountId: 'acct_1', connector: 'gmail', method: 'oauth', displayName: 'owner@example.com', ...(reconnected ? { reconnected } : {}) } }) as unknown as AuditEvent;

    it('have their own filter, words and tones, and lead to the connector page', () => {
        expect(HISTORY_KIND_FILTERS.find((f) => f.id === 'connectors')!.kinds).toEqual(['connector.connected', 'connector.needs-reauth', 'connector.disconnected']);
        expect([kindLabel(event('connector.connected')), kindLabel(event('connector.connected', true)), kindLabel(event('connector.needs-reauth')), kindLabel(event('connector.disconnected'))]).toEqual(['connected', 'reconnected', 'needs reconnecting', 'disconnected']);
        expect(toneOf(event('connector.needs-reauth'))).toBe('failed');
        expect(refOf(event('connector.connected'))).toEqual({ label: 'owner@example.com', href: '/plugins/gmail' });
    });
});
