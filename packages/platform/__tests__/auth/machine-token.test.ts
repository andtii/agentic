// @vitest-environment node
import { bearerToken, hashMachineToken, issueMachineToken, parseMachineToken, verifyMachineToken } from '../../src/index';
import type { MachineId, WorkspaceId } from '@agentic/core';

const ref = { workspaceId: 'ws_1' as WorkspaceId, machineId: 'machine_1' as MachineId };

describe('machine tokens', () => {
    it('issue: the token names its ids in the clear and the record stores only the hash', async () => {
        const issued = await issueMachineToken(ref);
        expect(issued.token).toMatch(/^amt\.ws_1\.machine_1\.[A-Za-z0-9_-]{43}$/);
        expect(issued.tokenHash).toBe(await hashMachineToken(issued.token));
        expect(issued.tokenHash).not.toContain(issued.token.split('.')[3]);
        expect(parseMachineToken(issued.token)).toEqual(ref);
        await expect(issueMachineToken({ ...ref, machineId: 'bad:id' as MachineId })).rejects.toThrow(/url-safe/);
    });

    it('parse refuses anything not shaped like a token', () => {
        expect(parseMachineToken('amt.ws_1.machine_1')).toBeNull();
        expect(parseMachineToken('amt.ws_1.machine_1.short')).toBeNull();
        expect(parseMachineToken('agt.ws_1.machine_1.' + 'a'.repeat(43))).toBeNull();
        expect(parseMachineToken(null)).toBeNull();
    });

    it('verify: hash match → machine principal; mismatch, unknown, revoked → refused', async () => {
        const issued = await issueMachineToken(ref);
        await expect(verifyMachineToken(issued.token, { tokenHash: issued.tokenHash })).resolves.toEqual({ ok: true, principal: { kind: 'machine', ...ref } });
        await expect(verifyMachineToken(issued.token, { tokenHash: issued.tokenHash, revokedAt: null })).resolves.toMatchObject({ ok: true });
        await expect(verifyMachineToken(issued.token, { tokenHash: issued.tokenHash, revokedAt: 123 })).resolves.toEqual({ ok: false, reason: 'revoked' });
        await expect(verifyMachineToken(issued.token, null)).resolves.toEqual({ ok: false, reason: 'unknown' });
        const other = await issueMachineToken(ref);
        await expect(verifyMachineToken(other.token, { tokenHash: issued.tokenHash })).resolves.toEqual({ ok: false, reason: 'mismatch' });
        await expect(verifyMachineToken('nope', { tokenHash: issued.tokenHash })).resolves.toEqual({ ok: false, reason: 'malformed' });
    });

    it('bearerToken reads the Authorization header case-insensitively', () => {
        expect(bearerToken(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
        expect(bearerToken(new Headers({ authorization: 'Basic abc' }))).toBeNull();
        expect(bearerToken(new Headers())).toBeNull();
    });
});
