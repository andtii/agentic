/**
 * Lessons (LRN-04..06): what was learned (`text`), the evidence behind it
 * (`evidence`), and when it applies (`conditions`). Built from corrections and
 * refuted outcomes, retrieved before similar tasks, retired or superseded
 * when wrong. All of it is plain `MemoryStore` calls — any MemoryPlugin works.
 */

import type { Correction, MemoryEntry, MemoryStore, NewMemoryEntry, RankedMemory } from '@agentic/core';
import { applyProposals } from '../proposals/index.js';

/** What the caller knows about the work a correction or lesson belongs to. */
export interface LearningContext {
    /** The task objective or the request being answered. */
    readonly objective?: string;
    readonly tags?: readonly string[];
}

export const CORRECTION_TAG = 'correction';
export const EVIDENCE_CORRECTION_PREFIX = 'correction(';

const STOP: ReadonlySet<string> = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with']);

/** Lowercase letter/digit words of two or more characters, minus a small stop list. */
export function words(text: string): Set<string> {
    const out = new Set<string>();
    for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length > 1 && !STOP.has(w)) out.add(w);
    return out;
}

/** Jaccard overlap of two texts' word sets, 0..1. */
export function similarity(a: string, b: string): number {
    const x = words(a);
    const y = words(b);
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / (x.size + y.size - shared);
}

/** One line of evidence for a correction: who, when, where, what they said. */
export function correctionEvidence(c: Correction): string {
    return `${EVIDENCE_CORRECTION_PREFIX}${c.what}) by ${c.by} at ${new Date(c.at).toISOString()} in ${c.sessionId}/${c.messageId}: ${c.text}`;
}

/** The evidence line that carries a merged lesson's running total, independent of the evidence cap. */
export const EVIDENCE_TOTAL_PREFIX = 'corrections in total: ';

/** How many corrections a lesson stands for: the running total when merged, else the correction lines. */
export function correctionOccurrences(entry: Pick<MemoryEntry, 'evidence'>): number {
    const evidence = entry.evidence ?? [];
    const total = evidence.find((e) => e.startsWith(EVIDENCE_TOTAL_PREFIX));
    if (total) {
        const n = Number.parseInt(total.slice(EVIDENCE_TOTAL_PREFIX.length), 10);
        if (Number.isSafeInteger(n) && n >= 0) return n;
    }
    return evidence.filter((e) => e.startsWith(EVIDENCE_CORRECTION_PREFIX)).length;
}

function conditionsFor(c: Correction, context: LearningContext | undefined): string {
    const objective = context?.objective?.trim();
    if (objective) return `Tasks like: ${objective}`;
    return `Whenever this comes up again: ${c.text}`;
}

/**
 * The lesson a correction teaches. A user correction is a stated lesson with
 * `provenance.source: 'user'`; an agent-detected one is only an assumption.
 */
export function lessonFromCorrection(c: Correction, context?: LearningContext): NewMemoryEntry {
    return {
        kind: 'lesson',
        text: c.text,
        tags: [CORRECTION_TAG, `${CORRECTION_TAG}:${c.what}`, ...(context?.tags ?? [])],
        conditions: conditionsFor(c, context),
        evidence: [correctionEvidence(c)],
        confidence: c.by === 'user' ? 'stated' : 'assumed',
        provenance: { source: c.by, at: c.at, sessionId: c.sessionId, messageId: c.messageId }
    };
}

/** The live correction lesson of the same kind that says nearly the same thing, if any. */
export async function findSimilarLesson(memory: MemoryStore, c: Correction, threshold: number): Promise<MemoryEntry | undefined> {
    const hits = await memory.query({ text: c.text, kinds: ['lesson'], tags: [`${CORRECTION_TAG}:${c.what}`], limit: 10 });
    let best: { entry: MemoryEntry; sim: number } | undefined;
    for (const { entry } of hits) {
        if (entry.retired) continue;
        const sim = similarity(entry.text, c.text);
        if (sim >= threshold && (!best || sim > best.sim)) best = { entry, sim };
    }
    return best?.entry;
}

function mergeConditions(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) return b;
    if (!b || a.includes(b)) return a;
    return `${a}\n${b}`;
}

/**
 * The replacement for `previous` after the same correction came again: the
 * latest wording, both sets of tags and conditions, evidence accumulated (the
 * newest `evidenceCap` lines, behind a running-total line the cap never
 * trims), `supersedes` pointing at the old lesson.
 */
export function mergeLesson(previous: MemoryEntry, next: NewMemoryEntry, evidenceCap: number): NewMemoryEntry {
    const total = correctionOccurrences(previous) + correctionOccurrences(next);
    const lines = [...(previous.evidence ?? []), ...(next.evidence ?? [])].filter((e) => !e.startsWith(EVIDENCE_TOTAL_PREFIX));
    const kept = lines.slice(Math.max(0, lines.length - Math.max(1, evidenceCap)));
    const conditions = mergeConditions(previous.conditions, next.conditions);
    return {
        ...next,
        tags: [...previous.tags, ...next.tags],
        ...(conditions ? { conditions } : {}),
        evidence: total > 0 ? [`${EVIDENCE_TOTAL_PREFIX}${total}`, ...kept] : kept,
        confidence: previous.confidence === 'stated' || next.confidence === 'stated' ? 'stated' : next.confidence,
        supersedes: previous.id
    };
}

export interface RelevantLessonsOptions {
    /** Default 5. */
    readonly limit?: number;
    /** Byte budget over lesson text (MEM-07). Default: the store's. */
    readonly maxBytes?: number;
}

function sharesWord(entry: MemoryEntry, query: ReadonlySet<string>): boolean {
    const doc = words([entry.text, entry.conditions ?? '', ...entry.tags].join(' '));
    for (const w of query) if (doc.has(w)) return true;
    return false;
}

/**
 * Lessons that apply to a task about to start (LRN-05, AC-09): ranked by the
 * store on the objective and tags; a lesson sharing no word with them is not
 * relevant, however fresh. Retired lessons are never returned, even from a
 * store that leaks them.
 */
export async function relevantLessons(memory: MemoryStore, context: LearningContext, options: RelevantLessonsOptions = {}): Promise<readonly RankedMemory[]> {
    const text = [context.objective ?? '', ...(context.tags ?? [])].join(' ').trim();
    const query = words(text);
    if (!query.size) return [];
    const limit = options.limit ?? 5;
    // Over-fetch: the store's ranking keeps no-overlap entries at a floor score; they are dropped here,
    // before the byte budget, so they cannot spend it.
    const hits = await memory.query({ text, kinds: ['lesson'], limit: limit * 4 });
    const out: RankedMemory[] = [];
    let bytes = 0;
    for (const h of hits) {
        if (out.length >= limit) break;
        if (h.entry.kind !== 'lesson' || h.entry.retired || !sharesWord(h.entry, query)) continue;
        const size = encoder.encode(h.entry.text).byteLength;
        if (options.maxBytes !== undefined && bytes + size > options.maxBytes) continue;
        bytes += size;
        out.push(h);
    }
    return out;
}

const encoder = new TextEncoder();

/** Retire a lesson that turned out wrong or obsolete (LRN-06). */
export async function retireLesson(memory: MemoryStore, id: string, why: string): Promise<void> {
    await memory.retire(id, why);
}

/** Replace a lesson with a corrected one; the old one is retired and linked (LRN-06). */
export async function supersedeLesson(memory: MemoryStore, id: string, replacement: NewMemoryEntry): Promise<MemoryEntry> {
    const { written } = await applyProposals([{ kind: 'memory', entry: { ...replacement, kind: 'lesson', supersedes: id } }], memory);
    return written[0]!;
}
