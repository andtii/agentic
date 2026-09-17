/**
 * Proposals are the only output of learning. A proposal never carries a
 * permission, grant, tool allowance or policy (LRN-08): a memory proposal is a
 * `NewMemoryEntry` and nothing else, an instruction proposal is review-gated
 * text. The shape is enforced twice — `PermissionFree<T>` at the type level
 * and `assertPermissionFree` at runtime, on every proposal the plugin emits and
 * every proposal `applyProposals` is handed, whichever plugin produced it.
 */

import type { MemoryEntry, MemoryStore, Proposal } from '@agentic/core';

/** Keys that would widen what an agent may do. None may appear anywhere in a proposal. */
export const PERMISSION_KEYS = [
    'permissions',
    'permission',
    'grantedPermissions',
    'grants',
    'grant',
    'toolGrants',
    'allowedTools',
    'tools',
    'scopes',
    'policy',
    'approvalPolicy',
    'sandbox',
    'capabilities',
    'secrets'
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

type Leaf = string | number | boolean | bigint | symbol | null | undefined | ((...args: never[]) => unknown);

/** Every property key reachable in `T`, through arrays and nested objects. */
export type DeepKeys<T> = T extends Leaf ? never : T extends readonly (infer U)[] ? DeepKeys<U> : { [K in keyof T]-?: K | DeepKeys<T[K]> }[keyof T];

/** `T` when no permission key is reachable in it, `never` otherwise. */
export type PermissionFree<T> = [Extract<DeepKeys<T>, PermissionKey>] extends [never] ? T : never;

export type InstructionProposal = Extract<Proposal, { readonly kind: 'instruction' }>;
export type MemoryProposal = Extract<Proposal, { readonly kind: 'memory' }>;

const MEMORY_PROPOSAL_KEYS: ReadonlySet<string> = new Set(['kind', 'entry']);
const MEMORY_ENTRY_KEYS: ReadonlySet<string> = new Set<keyof MemoryEntry>(['kind', 'text', 'tags', 'subject', 'provenance', 'confidence', 'conditions', 'evidence', 'supersedes', 'retired', 'ttl']);
const PROVENANCE_KEYS: ReadonlySet<string> = new Set(['source', 'at', 'sessionId', 'taskId', 'messageId']);
const INSTRUCTION_KEYS: ReadonlySet<string> = new Set(['kind', 'patch', 'reason', 'requiresReview']);
const FORBIDDEN: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export class LearningPermissionError extends Error {
    override readonly name = 'LearningPermissionError';
    constructor(
        readonly path: string,
        reason: string
    ) {
        super(`${reason} at ${path}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanForbidden(value: unknown, path: string): void {
    if (Array.isArray(value)) {
        value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`));
        return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN.has(key)) throw new LearningPermissionError(`${path}.${key}`, 'a proposal may not carry permission fields');
        scanForbidden(value[key], `${path}.${key}`);
    }
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new LearningPermissionError(`${path}.${key}`, 'unknown proposal field');
    }
}

/** Plain data only: a class instance or proxy-like object could hide fields from the key scan. */
function isPlain(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
}

const MEMORY_KINDS: ReadonlySet<unknown> = new Set(['working', 'fact', 'preference', 'assumption', 'lesson', 'record']);
const CONFIDENCES: ReadonlySet<unknown> = new Set(['verified', 'stated', 'assumed']);
const SOURCES: ReadonlySet<unknown> = new Set(['user', 'agent', 'verification', 'import']);

function check(ok: boolean, path: string, reason: string): void {
    if (!ok) throw new LearningPermissionError(path, reason);
}

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const optional = (v: unknown, test: (v: unknown) => boolean): boolean => v === undefined || test(v);
const isString = (v: unknown): boolean => typeof v === 'string';

/** The `NewMemoryEntry` shape, field by field. */
function checkEntry(entry: Record<string, unknown>, path: string): void {
    onlyKeys(entry, MEMORY_ENTRY_KEYS, path);
    check(MEMORY_KINDS.has(entry.kind), `${path}.kind`, 'a memory entry needs a known kind');
    check(isString(entry.text), `${path}.text`, 'a memory entry needs text');
    check(isStringArray(entry.tags), `${path}.tags`, 'tags are a string array');
    check(CONFIDENCES.has(entry.confidence), `${path}.confidence`, 'a memory entry needs a known confidence');
    check(optional(entry.subject, isString), `${path}.subject`, 'subject is text');
    check(optional(entry.conditions, isString), `${path}.conditions`, 'conditions are text');
    check(optional(entry.supersedes, isString), `${path}.supersedes`, 'supersedes is an id');
    check(optional(entry.evidence, isStringArray), `${path}.evidence`, 'evidence is a string array');
    check(optional(entry.retired, (v) => typeof v === 'boolean'), `${path}.retired`, 'retired is a boolean');
    check(optional(entry.ttl, (v) => typeof v === 'number' && Number.isFinite(v)), `${path}.ttl`, 'ttl is a number');
    const provenance = entry.provenance;
    check(isPlain(provenance), `${path}.provenance`, 'a memory entry needs provenance');
    const p = provenance as Record<string, unknown>;
    onlyKeys(p, PROVENANCE_KEYS, `${path}.provenance`);
    check(SOURCES.has(p.source), `${path}.provenance.source`, 'provenance needs a known source');
    check(optional(p.at, (v) => typeof v === 'number' && Number.isFinite(v)), `${path}.provenance.at`, 'at is a number');
    for (const k of ['sessionId', 'taskId', 'messageId'] as const) check(optional(p[k], isString), `${path}.provenance.${k}`, `${k} is an id`);
}

/**
 * Throw unless every proposal is exactly a memory entry or a review-gated
 * instruction patch: plain data, no permission key at any depth, no field
 * outside the contract, every required field present with its type,
 * `requiresReview: true` on every instruction.
 */
export function assertPermissionFree(proposals: readonly unknown[]): asserts proposals is readonly Proposal[] {
    proposals.forEach((p, i) => {
        const path = `proposals[${i}]`;
        if (!isPlain(p)) throw new LearningPermissionError(path, 'a proposal must be a plain object');
        scanForbidden(p, path);
        if (p.kind === 'memory') {
            onlyKeys(p, MEMORY_PROPOSAL_KEYS, path);
            if (!isPlain(p.entry)) throw new LearningPermissionError(`${path}.entry`, 'a memory proposal needs an entry');
            checkEntry(p.entry, `${path}.entry`);
        } else if (p.kind === 'instruction') {
            onlyKeys(p, INSTRUCTION_KEYS, path);
            check(p.requiresReview === true, `${path}.requiresReview`, 'an instruction proposal always requires review');
            check(isString(p.patch), `${path}.patch`, 'an instruction patch is text');
            check(isString(p.reason), `${path}.reason`, 'an instruction proposal needs a reason');
        } else {
            throw new LearningPermissionError(`${path}.kind`, 'unknown proposal kind');
        }
    });
}

export interface AppliedProposals {
    /** Entries written, in proposal order. */
    readonly written: readonly MemoryEntry[];
    /** Ids retired because a written entry superseded them. */
    readonly retired: readonly string[];
    /** Instruction proposals, untouched: they wait for review and land as a new Agent config version. */
    readonly pendingReview: readonly InstructionProposal[];
}

/**
 * Apply memory proposals (automatic, architecture §8) and hand back the
 * instruction proposals for review. An entry with `supersedes` retires the
 * entry it replaces (LRN-06). The whole batch is checked with
 * `assertPermissionFree` first — one bad proposal and nothing is written.
 */
export async function applyProposals(proposals: readonly Proposal[], memory: MemoryStore): Promise<AppliedProposals> {
    assertPermissionFree(proposals);
    const written: MemoryEntry[] = [];
    const retired: string[] = [];
    const pendingReview: InstructionProposal[] = [];
    for (const p of proposals) {
        if (p.kind === 'instruction') {
            pendingReview.push(p);
            continue;
        }
        const entry = await memory.put(p.entry);
        written.push(entry);
        const old = p.entry.supersedes ? await memory.get(p.entry.supersedes) : undefined;
        if (old && !old.retired) {
            await memory.retire(old.id, `superseded by ${entry.id}`);
            retired.push(old.id);
        }
    }
    return { written, retired, pendingReview };
}
