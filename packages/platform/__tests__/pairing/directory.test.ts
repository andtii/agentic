/**
 * The PairingDirectory end to end (USR-04, #37): `Workspace.registerMachinePending`
 * files the code over a hop, the anonymous door resolves it once to the
 * machine it was issued for, and `Machine.pair` redeems it. Single use, 10 minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, Principal, WorkspaceId } from '@agentic/core';

import { parseMachineToken, workspaceKey } from '../../src/auth/index';
import { defineMachineActor, machineKey } from '../../src/machine/index';
import { PAIRING_DIRECTORY_KEY, PairingDirectory } from '../../src/pairing/index';
import { Workspace, PAIRING_CODE_TTL_MS } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });

let app: TestActorApp;
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    app = testActorApp([Workspace, PairingDirectory, Machine]);
    await app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const directory = (principal: Principal | null = null) => app.as(principal).actor(PairingDirectory, PAIRING_DIRECTORY_KEY);
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));

describe('PairingDirectory', () => {
    it('resolves a code filed by the Workspace once, anonymously, and Machine.pair redeems it', async () => {
        const { machineId, pairingCode } = await ws().registerMachinePending({ name: 'laptop' });
        expect(await directory(owner).count()).toBe(1);
        const target = await directory().resolve(pairingCode.toLowerCase());
        expect(target).toEqual({ workspaceId: WS, machineId });
        // Single use at the door.
        expect(await directory().resolve(pairingCode)).toBeNull();
        expect(await directory(owner).count()).toBe(0);

        const asMachine: Principal = { kind: 'machine', workspaceId: WS, machineId: machineId as MachineId };
        const paired = await app.as(asMachine).actor(Machine, machineKey(WS, machineId)).pair(pairingCode, { name: 'laptop', os: 'windows' });
        expect(parseMachineToken(paired.token)).toEqual({ workspaceId: WS, machineId });
        expect((await ws().listMachines()).find((m) => m.id === machineId)?.status).toBe('paired');
    });

    it('an unknown or expired code resolves to nothing', async () => {
        expect(await directory().resolve('ZZZZZZ')).toBeNull();
        const { pairingCode } = await ws().registerMachinePending({ name: 'laptop' });
        vi.setSystemTime(Date.now() + PAIRING_CODE_TTL_MS + 1);
        expect(await directory().resolve(pairingCode)).toBeNull();
        expect(await directory(owner).count()).toBe(0);
    });

    it('only the workspace user files codes; resolve is the one anonymous door', async () => {
        const entry = { workspaceId: WS, machineId: 'machine_x' as MachineId, expiresAt: Date.now() + 60_000 };
        expect([401, 403]).toContain(await statusOf(directory(null).register('ABCDEF', entry)));
        expect([401, 403]).toContain(await statusOf(directory({ kind: 'machine', workspaceId: WS, machineId: 'm' as MachineId }).register('ABCDEF', entry)));
        expect(await statusOf(directory(owner).register('ABCDEF', entry))).toBeUndefined();
        expect(await directory(null).resolve('ABC-DEF')).toEqual({ workspaceId: WS, machineId: 'machine_x' });
    });
});
