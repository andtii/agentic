import type { Principal, WorkspaceId } from '@agentic/core';
import { actorKey } from '@agentic/core';
import type { ServerFnContext, ServerPolicyOp } from '@sigx/server';
import { sameWorkspace, workspaceKey, workspaceOfActorKey, workspaceOwner } from '../src/auth/index';

const ws = 'u1' as WorkspaceId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const otherUser: Principal = { kind: 'user', userId: 'u2', workspaceId: 'u2' as WorkspaceId };
const agent: Principal = { kind: 'agent', workspaceId: ws, agentId: 'agent_1' as never, sessionId: 'session_1' as never };
const machine: Principal = { kind: 'machine', workspaceId: ws, machineId: 'machine_1' as never };
const external: Principal = { kind: 'external', workspaceId: ws, clientId: 'c1', scopes: ['agents'] };

const rq = {} as ServerFnContext;
const op = (key: string, type = 'Workspace'): ServerPolicyOp =>
    ({ fn: { name: 'x' }, args: [], resource: { kind: 'actor', type, key, method: 'get' } }) as unknown as ServerPolicyOp;

describe('workspaceOfActorKey', () => {
    it('reads the root key and every child key', () => {
        expect(workspaceOfActorKey(workspaceKey(ws))).toBe('u1');
        expect(workspaceOfActorKey(actorKey(ws, 'agent', 'agent_1'))).toBe('u1');
        expect(workspaceOfActorKey('ws:agent:x')).toBe('ws'); // three segments: a child of workspace `ws`
    });

    it('is null for keys of neither shape', () => {
        expect(workspaceOfActorKey('ws:')).toBeNull();
        expect(workspaceOfActorKey('bare')).toBeNull();
        expect(workspaceOfActorKey('')).toBeNull();
    });
});

describe('sameWorkspace', () => {
    it('admits every principal kind of the workspace, on the root and on children', async () => {
        for (const p of [user, agent, machine, external]) {
            expect(await sameWorkspace(p, rq, op(workspaceKey(ws)))).toBe(true);
            expect(await sameWorkspace(p, rq, op(actorKey(ws, 'chat', 'chat_1'), 'Chat'))).toBe(true);
        }
    });

    it('refuses another workspace, an anonymous caller and a resource-less op', async () => {
        expect(await sameWorkspace(otherUser, rq, op(workspaceKey(ws)))).toBe(false);
        expect(await sameWorkspace(otherUser, rq, op(actorKey(ws, 'chat', 'chat_1'), 'Chat'))).toBe(false);
        expect(await sameWorkspace(null, rq, op(workspaceKey(ws)))).toBe(false);
        expect(await sameWorkspace(user, rq, { fn: { name: 'x' }, args: [] } as unknown as ServerPolicyOp)).toBe(false);
        expect(await sameWorkspace(user, rq, op('bare'))).toBe(false);
    });
});

describe('workspaceOwner', () => {
    it('admits only the owning user', async () => {
        expect(await workspaceOwner(user, rq, op(workspaceKey(ws)))).toBe(true);
        for (const p of [otherUser, agent, machine, external, null]) {
            expect(await workspaceOwner(p, rq, op(workspaceKey(ws)))).toBe(false);
        }
    });
});
