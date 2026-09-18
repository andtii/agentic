/**
 * The storage-agnostic memory state and its reducer.
 *
 * Every mutation is a `MemoryLogEntry` folded into a `MemoryState` by
 * `applyMemoryLog(state, log)` — in place, deterministic, JSON-safe. The
 * in-memory store applies it directly; the Memory actor applies it to
 * `ctx.state` and persists (today `ctx.save()`, `ctx.append(log)` once
 * `@sigx/actors` ships the `applyEntry` seam — the reducer already has that
 * shape). Anything that decides WHAT to write (id minting, timestamps,
 * validation) lives in the command helpers below, never in the reducer, so
 * a replayed log folds to exactly the state it produced the first time.
 */

import type { MemoryEntry, MemoryKind, NewMemoryEntry, Provenance } from '@agentic/core';
import { normalizeTag } from '../tokenize/index.js';

export const MEMORY_STATE_VERSION = 1;

export interface Retirement {
    readonly why: string;
    readonly at: number;
}

export interface MemoryState {
    v: typeof MEMORY_STATE_VERSION;
    /** Bumped by every applied log entry; lets a retriever cache its index. */
    rev: number;
    entries: Record<string, MemoryEntry>;
    /** Why and when an entry was retired (MEM-08: the reason stays inspectable). */
    retirements: Record<string, Retirement>;
}

export type MemoryLogEntry =
    | { readonly op: 'put'; readonly entry: MemoryEntry }
    | { readonly op: 'update'; readonly id: string; readonly patch: Partial<Omit<MemoryEntry, 'id'>> }
    | { readonly op: 'retire'; readonly id: string; readonly why: string; readonly at: number }
    /** Remove an entry and its retirement for good (MEM-05, MEM-08). */
    | { readonly op: 'delete'; readonly id: string }
    /** Drop expired `working` entries (MEM-12: working context is temporary). */
    | { readonly op: 'compact'; readonly now: number };

export function createMemoryState(): MemoryState {
    return { v: MEMORY_STATE_VERSION, rev: 0, entries: {}, retirements: {} };
}

export const MEMORY_KINDS: readonly MemoryKind[] = ['working', 'fact', 'preference', 'assumption', 'lesson', 'record'];
const CONFIDENCES: readonly MemoryEntry['confidence'][] = ['verified', 'stated', 'assumed'];
const SOURCES: readonly Provenance['source'][] = ['user', 'agent', 'verification', 'import'];

/** `mem_<22 url-safe chars>`; `crypto.getRandomValues` exists on Workers, browsers and Node 20+. */
export function memoryId(): string {
    const bytes = new Uint8Array(22);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return `mem_${out}`;
}
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A `working` entry with a ttl expires `ttl` ms after its provenance timestamp. */
export function isExpired(entry: MemoryEntry, now: number): boolean {
    return entry.kind === 'working' && typeof entry.ttl === 'number' && entry.provenance.at + entry.ttl <= now;
}

export function isLive(entry: MemoryEntry, now: number): boolean {
    return !entry.retired && !isExpired(entry, now);
}

export function liveEntries(state: MemoryState, now: number): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const id in state.entries) {
        const e = state.entries[id]!;
        if (isLive(e, now)) out.push(e);
    }
    return out;
}

/** Every entry, retired included, ordered by id — the export order. */
export function allEntries(state: MemoryState): MemoryEntry[] {
    return Object.keys(state.entries)
        .sort()
        .map((id) => state.entries[id]!);
}

/** Stamp a new entry: id, `provenance.at`, normalized unique tags. Pure — the caller supplies the clock. */
export function completeEntry(input: NewMemoryEntry, now: number, id: string = memoryId()): MemoryEntry {
    const { provenance, tags, ...rest } = input;
    const entry: MemoryEntry = {
        ...rest,
        id,
        tags: uniqueTags(tags),
        provenance: { ...provenance, at: provenance.at ?? now }
    };
    return stripUndefined(entry);
}

function uniqueTags(tags: readonly string[] | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tags ?? []) {
        const n = normalizeTag(t);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/** JSON-safe: an `undefined` member would vanish on the wire and differ from the in-memory copy. */
function stripUndefined<T extends object>(value: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
    return out as T;
}

/** Fold one log entry into the state, in place. Unknown ids are ignored: the command layer validates before logging. */
export function applyMemoryLog(state: MemoryState, log: MemoryLogEntry): void {
    switch (log.op) {
        case 'put': {
            let entry = log.entry;
            if (entry.kind === 'record' && entry.provenance.taskId && !entry.retired) {
                // MEM-12 / architecture §8: records are compacted per task — one
                // live record per task; the newest supersedes the rest. A record
                // arriving already retired (an import) supersedes nothing.
                let latest: MemoryEntry | undefined;
                for (const id in state.entries) {
                    const other = state.entries[id]!;
                    if (other.id === entry.id || other.kind !== 'record' || other.retired || other.provenance.taskId !== entry.provenance.taskId) continue;
                    state.entries[id] = { ...other, retired: true };
                    state.retirements[id] = { why: `superseded by ${entry.id}`, at: entry.provenance.at };
                    if (!latest || other.provenance.at > latest.provenance.at) latest = other;
                }
                if (latest && !entry.supersedes) entry = { ...entry, supersedes: latest.id };
            }
            state.entries[entry.id] = entry;
            break;
        }
        case 'update': {
            const old = state.entries[log.id];
            if (!old) break;
            const patch = stripUndefined({ ...log.patch }) as Partial<MemoryEntry>;
            state.entries[log.id] = { ...old, ...patch, id: old.id, tags: patch.tags ? uniqueTags(patch.tags) : old.tags };
            break;
        }
        case 'retire': {
            const old = state.entries[log.id];
            if (!old) break;
            state.entries[log.id] = { ...old, retired: true };
            state.retirements[log.id] = { why: log.why, at: log.at };
            break;
        }
        case 'delete': {
            delete state.entries[log.id];
            delete state.retirements[log.id];
            break;
        }
        case 'compact': {
            for (const id in state.entries) {
                if (isExpired(state.entries[id]!, log.now)) {
                    delete state.entries[id];
                    delete state.retirements[id];
                }
            }
            break;
        }
    }
    state.rev += 1;
}

// ── validation of foreign rows (import, wire) ───────────────────────────────

const ENTRY_FIELDS: ReadonlySet<string> = new Set(['id', 'kind', 'text', 'tags', 'subject', 'provenance', 'confidence', 'conditions', 'evidence', 'supersedes', 'retired', 'ttl']);
const PROVENANCE_FIELDS: ReadonlySet<string> = new Set(['source', 'at', 'sessionId', 'taskId', 'messageId']);

export interface CoercedEntry {
    readonly entry: MemoryEntry;
    /** Fields the entry shape cannot represent, dotted for nested ones (MEM-09). */
    readonly dropped: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const optionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

/**
 * Validate a row of unknown origin into a `MemoryEntry`, reporting the fields
 * it had to drop. `null` when the row is not an entry at all (missing id,
 * kind, text or provenance, or a value of the wrong type).
 */
export function coerceEntry(row: unknown): CoercedEntry | null {
    if (!isRecord(row)) return null;
    const dropped: string[] = [];
    for (const k of Object.keys(row)) if (!ENTRY_FIELDS.has(k)) dropped.push(k);
    const { id, kind, text, tags, subject, provenance, confidence, conditions, evidence, supersedes, retired, ttl } = row;
    if (typeof id !== 'string' || !id) return null;
    if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof text !== 'string') return null;
    if (!isRecord(provenance)) return null;
    for (const k of Object.keys(provenance)) if (!PROVENANCE_FIELDS.has(k)) dropped.push(`provenance.${k}`);
    const { source, at, sessionId, taskId, messageId } = provenance;
    if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) return null;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (!optionalString(sessionId) || !optionalString(taskId) || !optionalString(messageId)) return null;
    if (tags !== undefined && !isStringArray(tags)) return null;
    if (!optionalString(subject) || !optionalString(conditions) || !optionalString(supersedes)) return null;
    if (confidence !== undefined && !(CONFIDENCES as readonly string[]).includes(confidence as string)) return null;
    if (evidence !== undefined && !isStringArray(evidence)) return null;
    if (retired !== undefined && typeof retired !== 'boolean') return null;
    if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl))) return null;
    const entry = stripUndefined({
        id,
        kind: kind as MemoryKind,
        text,
        tags: uniqueTags(tags),
        subject,
        provenance: stripUndefined({ source: source as Provenance['source'], at, sessionId, taskId, messageId }) as Provenance,
        confidence: (confidence as MemoryEntry['confidence'] | undefined) ?? 'stated',
        conditions,
        evidence,
        supersedes,
        retired,
        ttl
    }) as MemoryEntry;
    return { entry, dropped };
}
