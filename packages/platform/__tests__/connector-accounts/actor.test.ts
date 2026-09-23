/**
 * ConnectorAccounts actor (#532): conduit's AccountStore / TransientStore / LockProvider semantics
 * through `connectorAccountStores`, sealed credentials only, workspace isolation, the audit trail.
 *
 * `@aigntiq/conduit` does not publish its `testing` entry (alias-only in its own workspace), so
 * `./conformance.ts` ports its three suites verbatim.
 */
import type { AgentId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { webCryptoCipher, type Credentials, type StoredAccount } from '@aigntiq/conduit';
import { AuditActor, auditKey, type AuditKind } from '../../src/audit/index';
import { connectorAccountStores, connectorAccountsKey, defineConnectorAccounts, parseConnectorAccountsKey, type ConnectorAccountsState } from '../../src/connector-accounts/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { accountStoreConformance, lockProviderConformance, transientStoreConformance } from './conformance';

/** The transient suite drives the clock; everything else reads the real one. */
let clock: { now: number } | null = null;
const ConnectorAccounts = defineConnectorAccounts({ now: () => clock?.now ?? Date.now() });

let app: TestActorApp;
beforeEach(() => {
    clock = null;
    app = testActorApp([ConnectorAccounts, AuditActor]);
    return app.start();
});
afterEach(() => app.stop());

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const agentOf = (ws: string): Principal => ({ kind: 'agent', workspaceId: ws as WorkspaceId, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId });
const machineOf = (ws: string): Principal => ({ kind: 'machine', workspaceId: ws as WorkspaceId, machineId: 'm1' as never });

const client = (p: Principal | null = owner, ws: string = WS) => app.as(p).actor(ConnectorAccounts, connectorAccountsKey(ws));

/** A fresh workspace per call, so each conformance case starts empty. */
let n = 0;
const freshStores = () => {
    const ws = `cw${++n}`;
    return connectorAccountStores(client(userPrincipal(ws), ws));
};

const account = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
    id,
    owner: WS,
    connector: 'gmail',
    method: 'oauth',
    status: 'active',
    displayName: 'ada@example.com',
    credentials: 'v1.sealed',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...patch
});

const audited = async (kinds: AuditKind[]) => (await app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds })).events;
const stored = async (ws: string = WS): Promise<ConnectorAccountsState | undefined> => {
    const record = (await app.storage.load('ConnectorAccounts', connectorAccountsKey(ws))) as { state?: ConnectorAccountsState } | null | undefined;
    return record?.state;
};

accountStoreConformance('ConnectorAccounts actor', () => freshStores().accounts);
transientStoreConformance('ConnectorAccounts actor', (c) => {
    clock = c;
    return freshStores().transient;
});
lockProviderConformance('ConnectorAccounts actor', () => freshStores().locks);

describe('connector-accounts keys', () => {
    it('round-trips and rejects other shapes', () => {
        expect(connectorAccountsKey(WS)).toBe('u1:connector-accounts');
        expect(parseConnectorAccountsKey('u1:connector-accounts')).toBe('u1');
        expect(parseConnectorAccountsKey('u1:registry')).toBeNull();
        expect(parseConnectorAccountsKey(':connector-accounts')).toBeNull();
    });
});

describe('sealed credentials only', () => {
    it('stores what the cipher sealed — never the token — and survives a restart', async () => {
        const cipher = webCryptoCipher('a-known-test-secret-of-at-least-32-chars');
        const token = 'ya29.plaintext-access-token';
        const credentials: Credentials = { values: {}, accessToken: token, refreshToken: '1//refresh-token', expiresAt: 10 };
        const sealed = await cipher.seal(JSON.stringify(credentials));
        const { accounts } = connectorAccountStores(client());
        await accounts.create(account('acc_1', { credentials: sealed }));

        const state = await stored();
        expect(state?.accounts['acc_1']?.credentials).toBe(sealed);
        const raw = JSON.stringify(state);
        expect(raw).not.toContain(token);
        expect(raw).not.toContain('refresh-token');
        // …and it opens back to the same credentials with the key, after the host restarts.
        await app.stop();
        app = testActorApp([ConnectorAccounts, AuditActor], { storage: app.storage });
        await app.start();
        const back = await connectorAccountStores(client()).accounts.get('acc_1');
        expect(JSON.parse(await cipher.open(back!.credentials))).toEqual(credentials);
    });

    it('refuses credentials that were never sealed', async () => {
        const plain = JSON.stringify({ values: {}, accessToken: 'ya29.x' });
        expect(await statusOf(client().createAccount(account('acc_plain', { credentials: plain })))).toBe(400);
        await client().createAccount(account('acc_ok'));
        expect(await statusOf(client().updateAccount(account('acc_ok', { credentials: plain, version: 2 }), 1))).toBe(400);
        expect((await client().getAccount('acc_ok'))?.credentials).toBe('v1.sealed');
    });

    it('refuses a malformed account', async () => {
        expect(await statusOf(client().createAccount({ ...account('x'), status: 'weird' } as never))).toBe(400);
        expect(await statusOf(client().createAccount(account('__proto__')))).toBe(400);
        expect(await statusOf(client().createAccount({ ...account('y'), version: 'one' } as never))).toBe(400);
    });

    it('exports and lists accounts without credentials', async () => {
        await client().createAccount(account('acc_2', { credentials: 'v1.secret-bytes', data: { region: 'eu' } }));
        const rows = await client().exportRows();
        expect(rows).toEqual([{ kind: 'connector-account', account: { id: 'acc_2', connector: 'gmail', status: 'active', displayName: 'ada@example.com' } }]);
        const summaries = await client(machineOf('u1')).accounts();
        expect(summaries).toEqual([{ id: 'acc_2', connector: 'gmail', method: 'oauth', status: 'active', displayName: 'ada@example.com', createdAt: 1, updatedAt: 1 }]);
        expect(JSON.stringify([rows, summaries])).not.toContain('secret-bytes');
    });
});

describe('persistence', () => {
    it('every mutation saves in its turn; reads and locks do not', async () => {
        const c = client();
        const saves = () => app.saves.filter((s) => s.type === 'ConnectorAccounts').length;
        await c.createAccount(account('acc_s'));
        expect(saves()).toBe(1);
        await c.updateAccount(account('acc_s', { version: 2 }), 1);
        expect(saves()).toBe(2);
        await c.putTransient('state-1', 'verifier', 60_000);
        expect(saves()).toBe(3);
        await c.takeTransient('state-1');
        expect(saves()).toBe(4);
        await c.deleteAccount('acc_s');
        expect(saves()).toBe(5);
        await c.getAccount('acc_s');
        await c.listAccounts();
        await c.takeTransient('missing');
        await c.updateAccount(account('ghost', { version: 2 }), 1);
        const grant = await c.lock('k');
        await c.unlock('k', grant.token);
        expect(saves()).toBe(5);
    });

    it('prunes expired transients on write', async () => {
        clock = { now: 1000 };
        const c = client();
        await c.putTransient('old', 'a', 100);
        await c.putTransient('live', 'b', 10_000);
        clock.now = 2000;
        await c.putTransient('new', 'c', 100);
        expect(Object.keys((await stored())!.transient).sort()).toEqual(['live', 'new']);
    });

    it('refuses a transient that would be expired on arrival', async () => {
        for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(await statusOf(client().putTransient('s', 'v', ttl))).toBe(400);
        expect((await stored())?.transient ?? {}).toEqual({});
    });

    it('caps the transients in flight', async () => {
        await app.stop();
        const Capped = defineConnectorAccounts({ maxTransient: 2 });
        app = testActorApp([Capped]);
        await app.start();
        const c = app.as(owner).actor(Capped, connectorAccountsKey(WS));
        await c.putTransient('a', '1', 60_000);
        await c.putTransient('b', '2', 60_000);
        expect(await statusOf(c.putTransient('c', '3', 60_000))).toBe(429);
        await c.putTransient('a', 'replaced', 60_000);
        expect(await c.takeTransient('a')).toBe('replaced');
    });
});

describe('locks', () => {
    it('a lease lapses on its own, and a stale token cannot unlock the next holder', async () => {
        const c = client();
        const first = await c.lock('refresh', { leaseMs: 20 });
        const second = await c.lock('refresh', { leaseMs: 60_000 });
        expect(second.token).not.toBe(first.token);
        expect(await c.unlock('refresh', first.token)).toBe(false);
        expect(await c.unlock('refresh', second.token)).toBe(true);
    });

    it('unlock refuses a malformed key or token, and a wrong token is just false', async () => {
        const c = client();
        const held = await c.lock('k');
        expect(await statusOf(c.unlock('', held.token))).toBe(400);
        expect(await statusOf(c.unlock('k', ''))).toBe(400);
        expect(await c.unlock('k', 'not-the-token')).toBe(false);
        expect(await c.unlock('k', held.token)).toBe(true);
    });

    it('a waiter gives up with 423 after waitMs', async () => {
        const c = client();
        const held = await c.lock('refresh');
        expect(await statusOf(c.lock('refresh', { waitMs: 20 }))).toBe(423);
        expect(await c.unlock('refresh', held.token)).toBe(true);
        const again = await c.lock('refresh');
        expect(await c.unlock('refresh', again.token)).toBe(true);
    });

    it('a waiting lock does not hold up account writes', async () => {
        const c = client();
        const held = await c.lock('conduit:account:acc_w');
        const waiting = c.lock('conduit:account:acc_w');
        await c.createAccount(account('acc_w'));
        expect((await c.getAccount('acc_w'))?.id).toBe('acc_w');
        await c.unlock('conduit:account:acc_w', held.token);
        await c.unlock('conduit:account:acc_w', (await waiting).token);
    });

    it('two racing refreshes: the lock serializes them, and CAS on version stops a lost lock overwriting', async () => {
        const stores = connectorAccountStores(client());
        await stores.accounts.create(account('acc_r'));
        let refreshes = 0;
        // What conduit does under `withLock`: re-read, refresh only if nobody else did, write with CAS.
        const refresh = () =>
            stores.locks.withLock('conduit:account:acc_r', async () => {
                const latest = (await stores.accounts.get('acc_r'))!;
                if (latest.version > 1) return latest.version;
                refreshes++;
                await new Promise((r) => setTimeout(r, 10));
                return (await stores.accounts.update({ ...latest, credentials: 'v1.renewed', version: latest.version + 1 }, latest.version)) ? latest.version + 1 : -1;
            });
        expect(await Promise.all([refresh(), refresh()])).toEqual([2, 2]);
        expect(refreshes).toBe(1);
        // A writer that lost its lock (lease lapsed) still read version 1: its CAS fails, the renewal stays.
        expect(await stores.accounts.update(account('acc_r', { credentials: 'v1.stale', version: 2 }), 1)).toBe(false);
        expect((await stores.accounts.get('acc_r'))?.credentials).toBe('v1.renewed');
    });
});

describe('policy', () => {
    it("refuses another workspace's principals", async () => {
        await client().createAccount(account('acc_i'));
        for (const intruder of [userPrincipal('u2'), agentOf('u2'), machineOf('u2')]) {
            const c = client(intruder);
            expect(await statusOf(c.getAccount('acc_i'))).toBe(403);
            expect(await statusOf(c.accounts())).toBe(403);
            expect(await statusOf(c.exportRows())).toBe(403);
            expect(await statusOf(c.createAccount(account('acc_x')))).toBe(403);
            expect(await statusOf(c.putTransient('s', 'v', 1000))).toBe(403);
            expect(await statusOf(c.lock('k'))).toBe(403);
        }
        expect(await statusOf(client(null).getAccount('acc_i'))).toBeGreaterThanOrEqual(401);
    });

    it('the owner and an agent of the workspace use the stores; a machine reads summaries only', async () => {
        const agent = connectorAccountStores(client(agentOf('u1')));
        await agent.accounts.create(account('acc_a'));
        expect(await agent.accounts.update(account('acc_a', { version: 2 }), 1)).toBe(true);
        await agent.transient.put('st', 'v', 60_000);
        expect(await agent.transient.take('st')).toBe('v');
        expect(await agent.locks.withLock('k', async () => 'done')).toBe('done');

        const machine = client(machineOf('u1'));
        expect(await statusOf(machine.getAccount('acc_a'))).toBe(403);
        expect(await statusOf(machine.listAccounts())).toBe(403);
        expect(await statusOf(machine.updateAccount(account('acc_a', { version: 3 }), 2))).toBe(403);
        expect(await statusOf(machine.takeTransient('st'))).toBe(403);
        expect(await statusOf(machine.lock('k'))).toBe(403);
        expect((await machine.accounts()).map((a) => a.id)).toEqual(['acc_a']);
    });
});

describe('audit', () => {
    it('records connect, needsReauth, reconnect and disconnect — never a refresh, never credentials', async () => {
        const c = client();
        await c.createAccount(account('acc_t', { credentials: 'v1.first' }));
        await c.updateAccount(account('acc_t', { version: 2, credentials: 'v1.refreshed' }), 1);
        await c.updateAccount(account('acc_t', { version: 3, status: 'needsReauth' }), 2);
        await c.updateAccount(account('acc_t', { version: 4, status: 'active', credentials: 'v1.again' }), 3);
        await c.updateAccount(account('acc_t', { version: 9, status: 'needsReauth' }), 1); // lost CAS: no event
        await c.deleteAccount('acc_t');
        await c.deleteAccount('acc_t'); // nothing to delete: no event

        const events = [...(await audited(['connector.connected', 'connector.needs-reauth', 'connector.disconnected']))].reverse();
        expect(events.map((e) => e.kind)).toEqual(['connector.connected', 'connector.needs-reauth', 'connector.connected', 'connector.disconnected']);
        expect(events.every((e) => e.by === 'user:u1')).toBe(true);
        expect(events[0]!.data).toEqual({ accountId: 'acc_t', connector: 'gmail', method: 'oauth', displayName: 'ada@example.com' });
        expect(events[2]!.data).toMatchObject({ reconnected: true });
        expect(JSON.stringify(events)).not.toContain('v1.');
    });

    it('names the agent when a session flags an account', async () => {
        await client().createAccount(account('acc_g'));
        await client(agentOf('u1')).updateAccount(account('acc_g', { version: 2, status: 'needsReauth' }), 1);
        const [event] = await audited(['connector.needs-reauth']);
        expect(event).toMatchObject({ by: 'agent:agent_1', data: { accountId: 'acc_g' } });
    });
});
