/**
 * The four sealed tokens the authorization server hands out, all on the
 * package's `seal`/`open` HMAC envelope (`seal.ts`) so a token of one kind
 * never opens as another and every one carries its own expiry:
 *
 * - `oacd` authorization code — names the workspace and the code record;
 *   redeemed once through `OAuthStore.consumeCode`.
 * - `oaac` access token — short-lived, self-contained: workspace, client,
 *   grant, scopes. `verify` still checks the grant is not revoked.
 * - `oarf` refresh token — the grant plus its rotation generation; every
 *   refresh mints a new one and the old generation becomes a replay.
 * - `oatx` consent transaction — the validated authorization request,
 *   bound to the user, carried through the consent form.
 *
 * Sealing means the token endpoint can find the workspace's records from
 * the token alone, without a global lookup table for random strings.
 */
import type { Scope, WorkspaceId } from '@agentic/core';
import { randomBytes, toBase64Url } from '../encoding.js';
import { open, seal, type SealedPayload } from '../seal.js';
import { isScope } from './scopes.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONSENT_TTL_MS = 10 * 60 * 1000;

export const ACCESS_TOKEN_PREFIX = 'oaac.';
export const REFRESH_TOKEN_PREFIX = 'oarf.';

export interface CodeTokenPayload extends SealedPayload {
    readonly ws: WorkspaceId;
    readonly id: string;
}

export interface AccessTokenPayload extends SealedPayload {
    readonly ws: WorkspaceId;
    readonly cid: string;
    readonly gid: string;
    readonly uid: string;
    readonly sc: readonly Scope[];
    /** Issued at, epoch ms. */
    readonly iat: number;
}

export interface RefreshTokenPayload extends SealedPayload {
    readonly ws: WorkspaceId;
    readonly cid: string;
    readonly gid: string;
    readonly gen: number;
}

export interface ConsentPayload extends SealedPayload {
    readonly ws: WorkspaceId;
    readonly uid: string;
    readonly cid: string;
    readonly ru: string;
    readonly cc: string;
    readonly sc: readonly Scope[];
    readonly st?: string;
    readonly res?: string;
}

/** A fresh opaque id — 22 base64url chars from 16 random bytes. */
export function randomId(prefix = ''): string {
    return `${prefix}${toBase64Url(randomBytes(16))}`;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const scopes = (v: unknown): v is readonly Scope[] => Array.isArray(v) && v.every(isScope);

export function sealCode(payload: Omit<CodeTokenPayload, 'exp'>, secret: string, exp: number): Promise<string> {
    return seal<CodeTokenPayload>('oacd', { ...payload, exp }, secret);
}

export async function openCode(token: string | null | undefined, secret: string, now: number): Promise<CodeTokenPayload | null> {
    const p = await open<CodeTokenPayload>('oacd', token, secret, now);
    return p && str(p.ws) && str(p.id) ? p : null;
}

export function sealAccessToken(payload: Omit<AccessTokenPayload, 'exp'>, secret: string, exp: number): Promise<string> {
    return seal<AccessTokenPayload>('oaac', { ...payload, exp }, secret);
}

export async function openAccessToken(token: string | null | undefined, secret: string, now: number): Promise<AccessTokenPayload | null> {
    const p = await open<AccessTokenPayload>('oaac', token, secret, now);
    return p && str(p.ws) && str(p.cid) && str(p.gid) && str(p.uid) && scopes(p.sc) && typeof p.iat === 'number' ? p : null;
}

export function sealRefreshToken(payload: Omit<RefreshTokenPayload, 'exp'>, secret: string, exp: number): Promise<string> {
    return seal<RefreshTokenPayload>('oarf', { ...payload, exp }, secret);
}

export async function openRefreshToken(token: string | null | undefined, secret: string, now: number): Promise<RefreshTokenPayload | null> {
    const p = await open<RefreshTokenPayload>('oarf', token, secret, now);
    return p && str(p.ws) && str(p.cid) && str(p.gid) && Number.isInteger(p.gen) && p.gen >= 0 ? p : null;
}

export function sealConsent(payload: Omit<ConsentPayload, 'exp'>, secret: string, exp: number): Promise<string> {
    return seal<ConsentPayload>('oatx', { ...payload, exp }, secret);
}

export async function openConsent(token: string | null | undefined, secret: string, now: number): Promise<ConsentPayload | null> {
    const p = await open<ConsentPayload>('oatx', token, secret, now);
    return p && str(p.ws) && str(p.uid) && str(p.cid) && str(p.ru) && str(p.cc) && scopes(p.sc) ? p : null;
}
