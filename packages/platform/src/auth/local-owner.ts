/**
 * The local owner (#989): how a fresh self-hosted node is claimed without
 * email or a GitHub OAuth app.
 *
 * On its first run the host issues ONE claim token — a sealed `{ jti, exp }`
 * (kind `clm`) — writes it to its data directory and prints
 * `/auth/claim?t=…`. Whoever opens that link sets a passphrase and becomes
 * `local_owner`: a user id in its own namespace beside `dev_` (dev login) and
 * `gh_` (GitHub), and, like theirs, its own workspace's id (v1: one personal
 * workspace per user), so `workspaceOwner` admits it by construction. Later
 * logins present the passphrase.
 *
 * A claim token works once: the host keeps a `LocalOwnerRecord` whose
 * pending claim names the one live `jti`; redeeming it drops the claim and
 * stores the owner, so a second presentation of the same token — or any
 * token once an owner exists — is refused. An expired or forged token is
 * refused like an unknown one.
 *
 * Pure functions over the plain record: the host owns persistence (and
 * serializes redemptions), this module owns the rules. Edge-safe — WebCrypto
 * only (PBKDF2-SHA256 for the passphrase).
 */
import type { WorkspaceId } from '@agentic/core';
import { fromBase64Url, randomBytes, timingSafeEqual, toBase64Url, utf8 } from './encoding.js';
import { open, seal, type SealedPayload } from './seal.js';

/** The owner's user id — and, v1, its workspace id. Colon-free, so every actor key parses. */
export const LOCAL_OWNER_ID = 'local_owner';
/** A claim link lives a day; a restart after that issues a fresh one. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSPHRASE_MIN_LENGTH = 10;
/** Upper bound, so a hostile body cannot make PBKDF2 hash megabytes. */
export const PASSPHRASE_MAX_LENGTH = 1024;
/** PBKDF2-SHA256 iterations (OWASP 2023: 600k). Stored per hash, so raising it never locks an owner out. */
export const PASSPHRASE_ITERATIONS = 600_000;

export interface PendingClaim {
    /** The one token id that may still be redeemed. */
    readonly jti: string;
    readonly issuedAt: number;
    readonly exp: number;
}

export interface PassphraseHash {
    readonly alg: 'pbkdf2-sha256';
    readonly iterations: number;
    /** base64url */
    readonly salt: string;
    /** base64url, 32 bytes */
    readonly hash: string;
}

export interface LocalOwner {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
    readonly claimedAt: number;
    readonly passphrase: PassphraseHash;
}

/** What the host persists: at most one pending claim, and the owner once claimed. */
export interface LocalOwnerRecord {
    readonly claim?: PendingClaim | null;
    readonly owner?: LocalOwner | null;
}

interface ClaimPayload extends SealedPayload {
    readonly jti: string;
}

export interface IssuedClaim {
    /** The sealed token for the link — shown once, kept in the data dir. */
    readonly token: string;
    /** The record's new pending claim. */
    readonly claim: PendingClaim;
}

/** Mint a claim token. The caller stores `claim` on the record (replacing any older one, which is then dead). */
export async function issueClaim(secret: string, options: { now?: number; ttlMs?: number } = {}): Promise<IssuedClaim> {
    const now = options.now ?? Date.now();
    const claim: PendingClaim = { jti: toBase64Url(randomBytes(18)), issuedAt: now, exp: now + (options.ttlMs ?? CLAIM_TTL_MS) };
    const token = await seal<ClaimPayload>('clm', { jti: claim.jti, exp: claim.exp }, secret);
    return { token, claim };
}

/** Whether `record` still waits for a claim that has not expired. */
export function isClaimLive(record: LocalOwnerRecord, now: number = Date.now()): boolean {
    return !record.owner && !!record.claim && record.claim.exp > now;
}

export type ClaimRefusal = 'invalid' | 'used' | 'claimed';
export type ClaimVerdict = { readonly ok: true; readonly claim: PendingClaim } | { readonly ok: false; readonly reason: ClaimRefusal };

/**
 * Check a presented token without consuming it (the claim form's GET).
 * `claimed`: an owner exists; `invalid`: forged, malformed or expired;
 * `used`: a real token that is not the record's live one (redeemed, or replaced).
 */
export async function checkClaim(token: string | null | undefined, record: LocalOwnerRecord, secret: string, now: number = Date.now()): Promise<ClaimVerdict> {
    if (record.owner) return { ok: false, reason: 'claimed' };
    const payload = await open<ClaimPayload>('clm', token, secret, now);
    if (!payload || typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'invalid' };
    const claim = record.claim;
    if (!claim || !timingSafeEqual(utf8(claim.jti), utf8(payload.jti))) return { ok: false, reason: 'used' };
    if (claim.exp <= now) return { ok: false, reason: 'invalid' };
    return { ok: true, claim };
}

export type PassphraseRefusal = 'passphrase_short' | 'passphrase_long';

/** `null` when `passphrase` is acceptable to set; otherwise why not. */
export function passphraseProblem(passphrase: string): PassphraseRefusal | null {
    if (passphrase.length < PASSPHRASE_MIN_LENGTH) return 'passphrase_short';
    if (passphrase.length > PASSPHRASE_MAX_LENGTH) return 'passphrase_long';
    return null;
}

export type RedeemResult = { readonly ok: true; readonly record: LocalOwnerRecord; readonly owner: LocalOwner } | { readonly ok: false; readonly reason: ClaimRefusal | PassphraseRefusal };

/**
 * Redeem a claim: the token must be the record's live one, the passphrase
 * acceptable. On success the returned record has no claim (the token is
 * spent) and names the owner; the caller persists it BEFORE minting a
 * session, so a crash in between leaves a spent token, never a reusable one.
 */
export async function redeemClaim(
    token: string | null | undefined,
    passphrase: string,
    record: LocalOwnerRecord,
    secret: string,
    options: { now?: number; iterations?: number } = {}
): Promise<RedeemResult> {
    const now = options.now ?? Date.now();
    const verdict = await checkClaim(token, record, secret, now);
    if (!verdict.ok) return verdict;
    const problem = passphraseProblem(passphrase);
    if (problem) return { ok: false, reason: problem };
    const owner: LocalOwner = {
        userId: LOCAL_OWNER_ID,
        workspaceId: LOCAL_OWNER_ID as WorkspaceId,
        claimedAt: now,
        passphrase: await hashPassphrase(passphrase, options.iterations === undefined ? {} : { iterations: options.iterations })
    };
    return { ok: true, owner, record: { claim: null, owner } };
}

/** `true` when `passphrase` is the owner's. `false` for no owner, a wrong or an oversized passphrase. */
export async function verifyLocalOwner(record: LocalOwnerRecord, passphrase: string): Promise<boolean> {
    const owner = record.owner;
    if (!owner || typeof passphrase !== 'string' || passphrase.length > PASSPHRASE_MAX_LENGTH) return false;
    return verifyPassphrase(passphrase, owner.passphrase);
}

async function pbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', utf8(passphrase) as BufferSource, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

/** A salted PBKDF2-SHA256 hash of `passphrase`. */
export async function hashPassphrase(passphrase: string, options: { iterations?: number } = {}): Promise<PassphraseHash> {
    const iterations = options.iterations ?? PASSPHRASE_ITERATIONS;
    const salt = randomBytes(16);
    return { alg: 'pbkdf2-sha256', iterations, salt: toBase64Url(salt), hash: toBase64Url(await pbkdf2(passphrase, salt, iterations)) };
}

/** Constant-time check of `passphrase` against a stored hash; a malformed hash never matches. */
export async function verifyPassphrase(passphrase: string, stored: PassphraseHash): Promise<boolean> {
    if (!stored || stored.alg !== 'pbkdf2-sha256' || !Number.isInteger(stored.iterations) || stored.iterations < 1) return false;
    const salt = fromBase64Url(stored.salt);
    const want = fromBase64Url(stored.hash);
    if (!salt || !want) return false;
    return timingSafeEqual(await pbkdf2(passphrase, salt, stored.iterations), want);
}
