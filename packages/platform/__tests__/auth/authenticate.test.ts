// @vitest-environment node
import { authenticateRequest, createAuthenticate, issueMachineToken, mintAgentPrincipal, sealAgentToken, sealSession, sessionCookie, serverAuth, type MachineTokenRecord } from '../../src/index';
import type { AgentId, MachineId, Principal, SessionId, WorkspaceId } from '@agentic/core';

const SECRET = 'test-session-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;
const ws = 'ws_1' as WorkspaceId;
const machineId = 'machine_1' as MachineId;

const records = new Map<string, MachineTokenRecord>();
const options = { sessionSecret: SECRET, machines: async (ref: { machineId: string }) => records.get(ref.machineId) ?? null, now: () => NOW };

const rq = (headers: Record<string, string>) => new Request('https://app.test/x', { headers });

describe('authenticateRequest', () => {
    beforeEach(() => records.clear());

    it('cookie → user principal; no cookie → null', async () => {
        const cookie = sessionCookie(await sealSession({ userId: 'gh_1', workspaceId: ws }, SECRET, { now: NOW })).split(';')[0]!;
        await expect(authenticateRequest(rq({ cookie }), options)).resolves.toEqual({ kind: 'user', userId: 'gh_1', workspaceId: ws });
        await expect(authenticateRequest(rq({}), options)).resolves.toBeNull();
        await expect(authenticateRequest(rq({ cookie: '__Host-session=garbage' }), options)).resolves.toBeNull();
    });

    it('machine bearer → machine principal through the lookup; revoked, unknown or missing lookup → null', async () => {
        const issued = await issueMachineToken({ workspaceId: ws, machineId });
        const authorization = `Bearer ${issued.token}`;
        await expect(authenticateRequest(rq({ authorization }), options)).resolves.toBeNull();
        records.set(machineId, { tokenHash: issued.tokenHash });
        await expect(authenticateRequest(rq({ authorization }), options)).resolves.toEqual({ kind: 'machine', workspaceId: ws, machineId });
        records.set(machineId, { tokenHash: issued.tokenHash, revokedAt: NOW });
        await expect(authenticateRequest(rq({ authorization }), options)).resolves.toBeNull();
        records.set(machineId, { tokenHash: issued.tokenHash });
        await expect(authenticateRequest(rq({ authorization }), { sessionSecret: SECRET })).resolves.toBeNull();
        await expect(authenticateRequest(rq({ authorization }), { ...options, machines: async () => { throw new Error('storage down'); } })).resolves.toBeNull();
    });

    it('agent bearer → the sealed agent principal', async () => {
        const agent = mintAgentPrincipal({ workspaceId: ws, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId }) as Principal & { kind: 'agent' };
        const token = await sealAgentToken(agent, SECRET, { now: NOW });
        await expect(authenticateRequest(rq({ authorization: `Bearer ${token}` }), options)).resolves.toEqual(agent);
    });

    it('a bad bearer is anonymous even when a valid cookie is present — no silent downgrade', async () => {
        const cookie = sessionCookie(await sealSession({ userId: 'gh_1', workspaceId: ws }, SECRET, { now: NOW })).split(';')[0]!;
        await expect(authenticateRequest(rq({ cookie, authorization: 'Bearer amt.ws_1.machine_1.' + 'x'.repeat(43) }), options)).resolves.toBeNull();
        await expect(authenticateRequest(rq({ cookie, authorization: 'Bearer agt.nope' }), options)).resolves.toBeNull();
        await expect(authenticateRequest(rq({ cookie, authorization: 'Bearer something-else' }), options)).resolves.toBeNull();
    });
});

describe('createAuthenticate (the createServerApp hook)', () => {
    it('reads rq.request, and is anonymous on a detached context instead of throwing', async () => {
        const authenticate = createAuthenticate(options);
        const cookie = sessionCookie(await sealSession({ userId: 'gh_1', workspaceId: ws }, SECRET, { now: NOW })).split(';')[0]!;
        await expect(authenticate({ request: rq({ cookie }) })).resolves.toMatchObject({ kind: 'user' });
        const detached = {
            get request(): Request {
                throw new Error('[sigx] detached context');
            }
        };
        await expect(authenticate(detached)).resolves.toBeNull();
        await expect(authenticate({ request: undefined as unknown as Request })).resolves.toBeNull();
        // Request-shaped but without a `headers.get` — anonymous, not a throw.
        await expect(authenticate({ request: { url: 'https://app.test/', headers: {} } as unknown as Request })).resolves.toBeNull();
    });

    it('serverAuth pairs the hook with the principal codec', () => {
        const app = serverAuth(options);
        expect(typeof app.authenticate).toBe('function');
        const p: Principal = { kind: 'user', userId: 'u', workspaceId: ws };
        expect(app.codec.decode(app.codec.encode(p))).toEqual(p);
    });
});
