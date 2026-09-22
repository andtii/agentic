// @vitest-environment node
import { decodePrincipal, encodePrincipal, isPrincipal, mintAgentPrincipal, principalCodec, sealAgentToken, openAgentToken, asPrincipal } from '../../src/index';
import { principal as readPrincipal } from '@sigx/server/server';
import type { AgentId, MachineId, Principal, SessionId, TaskId, WorkspaceId } from '@agentic/core';

const ws = 'ws_1' as WorkspaceId;
const NOW = 1_800_000_000_000;
const SECRET = 'test-session-secret-that-is-long-enough';

const all: Principal[] = [
    { kind: 'user', userId: 'gh_1', workspaceId: ws },
    { kind: 'user', userId: 'gh_1', workspaceId: ws, elevatedUntil: NOW + 600_000 },
    { kind: 'machine', workspaceId: ws, machineId: 'machine_1' as MachineId },
    { kind: 'agent', workspaceId: ws, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId },
    { kind: 'agent', workspaceId: ws, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId, taskId: 'task_1' as TaskId },
    { kind: 'external', workspaceId: ws, clientId: 'c1', scopes: ['agents', 'tasks'] }
];

describe('principal codec', () => {
    it.each(all)('round-trips %o', (p) => {
        const encoded = encodePrincipal(p);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodePrincipal(encoded)).toEqual(p);
        expect(principalCodec.decode(principalCodec.encode(p))).toEqual(p);
    });

    it('decodes nothing that is not a well-formed principal — anonymous, never a guess', () => {
        expect(decodePrincipal('')).toBeNull();
        expect(decodePrincipal('not base64!')).toBeNull();
        expect(decodePrincipal(encodePrincipal({ kind: 'user', userId: 'x', workspaceId: ws }).slice(0, -3))).toBeNull();
        for (const bad of [
            { kind: 'root', workspaceId: ws },
            { kind: 'user', userId: '', workspaceId: ws },
            { kind: 'user', userId: 'x' },
            { kind: 'user', userId: 'x', workspaceId: ws, admin: true },
            { kind: 'user', userId: 'x', workspaceId: ws, elevatedUntil: 'forever' },
            { kind: 'user', userId: 'x', workspaceId: ws, elevatedUntil: Number.POSITIVE_INFINITY },
            { kind: 'machine', workspaceId: ws, machineId: 'm', elevatedUntil: 1 },
            { kind: 'external', workspaceId: ws, clientId: 'c', scopes: ['everything'] },
            { kind: 'agent', workspaceId: ws, agentId: 'a', sessionId: 's', taskId: 1 },
            null,
            'user'
        ]) {
            expect(isPrincipal(bad)).toBe(false);
        }
    });

    it('mintAgentPrincipal drops an absent taskId so equality is stable', () => {
        const p = mintAgentPrincipal({ workspaceId: ws, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId, taskId: undefined });
        expect(Object.keys(p)).toEqual(['kind', 'workspaceId', 'agentId', 'sessionId']);
    });
});

describe('agent token', () => {
    const agent = mintAgentPrincipal({ workspaceId: ws, agentId: 'agent_1' as AgentId, sessionId: 'session_1' as SessionId, taskId: 'task_1' as TaskId });

    it('carries the minted principal for its lifetime only', async () => {
        const token = await sealAgentToken(agent as Principal & { kind: 'agent' }, SECRET, { now: NOW, ttlMs: 1000 });
        expect(token.startsWith('agt.')).toBe(true);
        await expect(openAgentToken(token, SECRET, NOW + 999)).resolves.toEqual(agent);
        await expect(openAgentToken(token, SECRET, NOW + 1000)).resolves.toBeNull();
        await expect(openAgentToken(token, 'a-different-secret-that-is-long', NOW)).resolves.toBeNull();
    });

    it('asPrincipal seeds a context the pipeline reads without authenticate', async () => {
        const context = asPrincipal(agent);
        await expect(readPrincipal(context as never)).resolves.toEqual(agent);
    });
});
