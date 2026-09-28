// @vitest-environment node
/** The local owner's claim token and passphrase (#989): one use, expiry, forgery, PBKDF2. */
import { describe, expect, it } from 'vitest';
import { checkClaim, hashPassphrase, isClaimLive, issueClaim, LOCAL_OWNER_ID, redeemClaim, seal, verifyLocalOwner, verifyPassphrase, type LocalOwnerRecord } from '../../src/index';

const SECRET = 'test-session-secret-that-is-long-enough';
const OTHER = 'another-secret-that-is-also-long-enough';
const NOW = 1_800_000_000_000;
const PASS = 'correct horse battery';
const fast = { iterations: 1_000 };

describe('local owner claim', () => {
    it('works once and only once', async () => {
        const { token, claim } = await issueClaim(SECRET, { now: NOW });
        let record: LocalOwnerRecord = { claim };
        expect(isClaimLive(record, NOW)).toBe(true);
        expect(await checkClaim(token, record, SECRET, NOW)).toEqual({ ok: true, claim });

        const first = await redeemClaim(token, PASS, record, SECRET, { now: NOW + 1, ...fast });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.owner).toMatchObject({ userId: LOCAL_OWNER_ID, workspaceId: LOCAL_OWNER_ID, claimedAt: NOW + 1 });
        expect(first.record.claim).toBeNull();
        record = first.record;
        expect(isClaimLive(record, NOW)).toBe(false);

        // Reused: the node is claimed now.
        expect(await redeemClaim(token, PASS, record, SECRET, { now: NOW + 2, ...fast })).toEqual({ ok: false, reason: 'claimed' });
        // Even against the record as it stood before, a claim without the pending jti is spent.
        expect(await checkClaim(token, { claim: null }, SECRET, NOW + 2)).toEqual({ ok: false, reason: 'used' });
    });

    it('refuses an expired, forged, foreign or replaced token', async () => {
        const { token, claim } = await issueClaim(SECRET, { now: NOW, ttlMs: 1_000 });
        const record: LocalOwnerRecord = { claim };
        expect(await checkClaim(token, record, SECRET, NOW + 1_000)).toEqual({ ok: false, reason: 'invalid' });
        expect(isClaimLive(record, NOW + 1_000)).toBe(false);
        expect(await checkClaim(token, record, OTHER, NOW)).toEqual({ ok: false, reason: 'invalid' });
        expect(await checkClaim(`${token}x`, record, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
        expect(await checkClaim(null, record, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
        // A token of another kind never claims, even with the right jti.
        const session = await seal('ses', { jti: claim.jti, exp: NOW + 1_000 }, SECRET);
        expect(await checkClaim(session, record, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
        // A newer claim replaces the older one: the old token is dead.
        const fresh = await issueClaim(SECRET, { now: NOW });
        expect(await checkClaim(token, { claim: fresh.claim }, SECRET, NOW)).toEqual({ ok: false, reason: 'used' });
        expect((await checkClaim(fresh.token, { claim: fresh.claim }, SECRET, NOW)).ok).toBe(true);
    });

    it('refuses a short passphrase without spending the token', async () => {
        const { token, claim } = await issueClaim(SECRET, { now: NOW });
        expect(await redeemClaim(token, 'short', { claim }, SECRET, { now: NOW, ...fast })).toEqual({ ok: false, reason: 'passphrase_short' });
        expect(await redeemClaim(token, 'x'.repeat(2_000), { claim }, SECRET, { now: NOW, ...fast })).toEqual({ ok: false, reason: 'passphrase_long' });
        expect((await redeemClaim(token, PASS, { claim }, SECRET, { now: NOW, ...fast })).ok).toBe(true);
    });
});

describe('local owner passphrase', () => {
    it('verifies the right passphrase only', async () => {
        const { token, claim } = await issueClaim(SECRET, { now: NOW });
        const result = await redeemClaim(token, PASS, { claim }, SECRET, { now: NOW, ...fast });
        if (!result.ok) throw new Error('claim failed');
        expect(await verifyLocalOwner(result.record, PASS)).toBe(true);
        expect(await verifyLocalOwner(result.record, `${PASS} `)).toBe(false);
        expect(await verifyLocalOwner({}, PASS)).toBe(false);
        expect(await verifyLocalOwner(result.record, 'x'.repeat(2_000))).toBe(false);
    });

    it('salts every hash and rejects a malformed one', async () => {
        const a = await hashPassphrase(PASS, fast);
        const b = await hashPassphrase(PASS, fast);
        expect(a.salt).not.toBe(b.salt);
        expect(a.hash).not.toBe(b.hash);
        expect(await verifyPassphrase(PASS, a)).toBe(true);
        expect(await verifyPassphrase(PASS, { ...a, iterations: 0 })).toBe(false);
        expect(await verifyPassphrase(PASS, { ...a, salt: '$$' })).toBe(false);
        expect(await verifyPassphrase(PASS, { ...a, alg: 'md5' as 'pbkdf2-sha256' })).toBe(false);
    });
});
