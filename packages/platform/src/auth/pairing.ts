/**
 * Machine pairing codes (USR-04, architecture §4 Workspace /
 * `registerMachinePending`): 6 characters, 10 minutes, single use.
 *
 * The Workspace actor stores the `PendingPairing` (hash only) and shows the
 * user the code; `agentic-daemon pair` presents it to the pairing endpoint,
 * which verifies against the pending record, consumes it, and issues a
 * machine token (`machine-token.ts`). Pure functions over plain records —
 * the actor owns persistence, this module owns the rules.
 */
import type { MachineId } from '@agentic/core';
import { randomBytes, sha256, timingSafeEqualText, toBase64Url } from './encoding.js';

/** Module-internal: the Workspace actor exports the surface-level `PAIRING_CODE_LENGTH` / `createPairingCode`. */
const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** No 0/O, 1/I/L: the code is read aloud and typed. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface PendingPairing {
    readonly machineId: MachineId;
    readonly codeHash: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    /** Set once redeemed; a second redemption is refused. */
    readonly consumedAt?: number | null;
}

export interface IssuedPairing {
    /** Show once to the user. */
    readonly code: string;
    /** Store on the Workspace actor. */
    readonly pending: PendingPairing;
}

export type PairingVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'malformed' | 'expired' | 'used' | 'mismatch' };

/** A fresh code from the unambiguous alphabet, rejection-sampled so every character is equally likely. */
function createPairingCode(): string {
    let out = '';
    const limit = 256 - (256 % PAIRING_ALPHABET.length);
    while (out.length < PAIRING_CODE_LENGTH) {
        for (const b of randomBytes(PAIRING_CODE_LENGTH * 2)) {
            if (b < limit) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
            if (out.length === PAIRING_CODE_LENGTH) break;
        }
    }
    return out;
}

/** Uppercase, strip separators and whitespace — what a user typed becomes what was issued. */
export function normalizePairingCode(input: string): string {
    return input.toUpperCase().replace(/[\s-]+/g, '');
}

export async function hashPairingCode(code: string): Promise<string> {
    return toBase64Url(await sha256(`pair:${normalizePairingCode(code)}`));
}

/** Mint a code for `machineId`. */
export async function issuePairing(input: { machineId: MachineId; now?: number; ttlMs?: number }): Promise<IssuedPairing> {
    const now = input.now ?? Date.now();
    const code = createPairingCode();
    return {
        code,
        pending: { machineId: input.machineId, codeHash: await hashPairingCode(code), issuedAt: now, expiresAt: now + (input.ttlMs ?? PAIRING_TTL_MS), consumedAt: null }
    };
}

/** Check a presented code against a pending record. Order: shape, used, expired, match. */
export async function verifyPairing(pending: PendingPairing | null | undefined, code: string, now: number = Date.now()): Promise<PairingVerdict> {
    const normalized = normalizePairingCode(code);
    if (normalized.length !== PAIRING_CODE_LENGTH || !pending) return { ok: false, reason: 'malformed' };
    if (pending.consumedAt !== undefined && pending.consumedAt !== null) return { ok: false, reason: 'used' };
    if (now >= pending.expiresAt) return { ok: false, reason: 'expired' };
    const hash = await hashPairingCode(normalized);
    if (!timingSafeEqualText(hash, pending.codeHash)) return { ok: false, reason: 'mismatch' };
    return { ok: true };
}

/** The record after a successful redemption — the actor saves this in the same turn. */
export function consumePairing(pending: PendingPairing, now: number = Date.now()): PendingPairing {
    return { ...pending, consumedAt: now };
}

export function isPairingLive(pending: PendingPairing, now: number = Date.now()): boolean {
    return (pending.consumedAt === undefined || pending.consumedAt === null) && now < pending.expiresAt;
}
