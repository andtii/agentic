/**
 * Machine tokens (USR-04): issued once at pairing, presented on every daemon
 * request as `Authorization: Bearer amt.<workspaceId>.<machineId>.<secret>`.
 *
 * The platform stores only the SHA-256 of the token (`tokenHash`) on the
 * Machine actor; the daemon keeps the token itself. The workspace and
 * machine ids ride in the clear so `authenticate` knows which record to
 * ask for — they are addresses, not proof; the proof is the hash match.
 * Revocation is a flag on the record: the next heartbeat after `revoke`
 * finds `revokedAt` set and is refused (acceptance: "a revoked machine
 * token is rejected at the next heartbeat").
 */
import type { MachineId, Principal, WorkspaceId } from '@agentic/core';
import { randomBytes, sha256, timingSafeEqualText, toBase64Url } from './encoding.js';
import { machinePrincipal } from './principal.js';

export const MACHINE_TOKEN_PREFIX = 'amt';

export interface MachineTokenRef {
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
}

export interface IssuedMachineToken extends MachineTokenRef {
    /** Hand to the daemon once; never stored. */
    readonly token: string;
    /** Store on the Machine actor. */
    readonly tokenHash: string;
}

/** What the Machine actor keeps. */
export interface MachineTokenRecord {
    readonly tokenHash: string;
    /** Epoch ms when revoked; absent or `null` while live. */
    readonly revokedAt?: number | null;
}

export type MachineTokenVerdict = { readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly reason: 'malformed' | 'unknown' | 'mismatch' | 'revoked' };

const ID = /^[A-Za-z0-9_-]+$/;
/** 32 random bytes as unpadded base64url — exactly what `issueMachineToken` mints. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** A fresh token + its hash for `ref`. */
export async function issueMachineToken(ref: MachineTokenRef): Promise<IssuedMachineToken> {
    if (!ID.test(ref.workspaceId) || !ID.test(ref.machineId)) throw new Error('[auth] machine token ids must be url-safe');
    const token = `${MACHINE_TOKEN_PREFIX}.${ref.workspaceId}.${ref.machineId}.${toBase64Url(randomBytes(32))}`;
    return { ...ref, token, tokenHash: await hashMachineToken(token) };
}

export async function hashMachineToken(token: string): Promise<string> {
    return toBase64Url(await sha256(token));
}

/** The ids a token names, or `null` when it is not shaped like a machine token. */
export function parseMachineToken(token: string | null | undefined): MachineTokenRef | null {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== MACHINE_TOKEN_PREFIX) return null;
    const [, workspaceId, machineId, secret] = parts as [string, string, string, string];
    if (!ID.test(workspaceId) || !ID.test(machineId) || !SECRET.test(secret)) return null;
    return { workspaceId: workspaceId as WorkspaceId, machineId: machineId as MachineId };
}

/** Compare a presented token with the stored record. `record` null = unknown machine. */
export async function verifyMachineToken(token: string, record: MachineTokenRecord | null | undefined): Promise<MachineTokenVerdict> {
    const ref = parseMachineToken(token);
    if (!ref) return { ok: false, reason: 'malformed' };
    if (!record) return { ok: false, reason: 'unknown' };
    // Compare the base64url texts constant-time; lengths match whenever the
    // stored value is a real hash, and a wrong length is a mismatch anyway.
    if (!timingSafeEqualText(await hashMachineToken(token), record.tokenHash)) return { ok: false, reason: 'mismatch' };
    if (record.revokedAt !== undefined && record.revokedAt !== null) return { ok: false, reason: 'revoked' };
    return { ok: true, principal: machinePrincipal(ref.workspaceId, ref.machineId) };
}

/** The bearer token on a request, or `null`. */
export function bearerToken(headers: Headers): string | null {
    const value = headers.get('authorization');
    if (!value) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
    return m ? m[1]! : null;
}
