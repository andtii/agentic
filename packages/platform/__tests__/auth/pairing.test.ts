// @vitest-environment node
import { consumePairing, hashPairingCode, isPairingLive, issuePairing, normalizePairingCode, PAIRING_ALPHABET, PAIRING_TTL_MS, verifyPairing } from '../../src/index';
import type { MachineId } from '@agentic/core';

const NOW = 1_800_000_000_000;
const machineId = 'machine_1' as MachineId;

describe('pairing codes (USR-04)', () => {
    it('are 6 characters from the unambiguous alphabet', async () => {
        for (let i = 0; i < 50; i++) {
            const { code } = await issuePairing({ machineId, now: NOW });
            expect(code).toHaveLength(6);
            for (const ch of code) expect(PAIRING_ALPHABET).toContain(ch);
        }
        expect(PAIRING_ALPHABET).not.toMatch(/[01IOL]/);
    });

    it('normalise what a human typed', () => {
        expect(normalizePairingCode(' ab c-def ')).toBe('ABCDEF');
    });

    it('issue stores a hash, never the code', async () => {
        const { code, pending } = await issuePairing({ machineId, now: NOW });
        expect(pending).toEqual({ machineId, codeHash: await hashPairingCode(code), issuedAt: NOW, expiresAt: NOW + PAIRING_TTL_MS, consumedAt: null });
        expect(JSON.stringify(pending)).not.toContain(code);
        expect(isPairingLive(pending, NOW)).toBe(true);
    });

    it('verify: the right code once, within 10 minutes', async () => {
        const { code, pending } = await issuePairing({ machineId, now: NOW });
        await expect(verifyPairing(pending, code.toLowerCase(), NOW + 1)).resolves.toEqual({ ok: true });
        await expect(verifyPairing(pending, code, NOW + PAIRING_TTL_MS - 1)).resolves.toEqual({ ok: true });
        await expect(verifyPairing(pending, code, NOW + PAIRING_TTL_MS)).resolves.toEqual({ ok: false, reason: 'expired' });
        const wrong = code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`;
        await expect(verifyPairing(pending, wrong, NOW)).resolves.toEqual({ ok: false, reason: 'mismatch' });
        await expect(verifyPairing(pending, 'ABC', NOW)).resolves.toEqual({ ok: false, reason: 'malformed' });
        await expect(verifyPairing(null, code, NOW)).resolves.toEqual({ ok: false, reason: 'malformed' });
    });

    it('is single use: a consumed record refuses even the right code', async () => {
        const { code, pending } = await issuePairing({ machineId, now: NOW });
        const used = consumePairing(pending, NOW + 5);
        expect(used.consumedAt).toBe(NOW + 5);
        expect(isPairingLive(used, NOW + 6)).toBe(false);
        await expect(verifyPairing(used, code, NOW + 6)).resolves.toEqual({ ok: false, reason: 'used' });
    });
});
