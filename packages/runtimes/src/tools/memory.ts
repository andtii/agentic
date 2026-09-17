/** `memory_search` and `memory_remember` — the agent's memory as tools (MEM-01..06). */

import { defineTool } from '@sigx/ai';
import { z } from 'zod';
import type { MemoryKind, NewMemoryEntry } from '@agentic/core';
import type { MemoryPort } from './ports.js';

const KINDS = ['working', 'fact', 'preference', 'assumption', 'lesson', 'record'] as const satisfies readonly MemoryKind[];

export const memorySearchInput = z.object({
    query: z.string().min(1).describe('What to look for, in plain words.'),
    kinds: z.array(z.enum(KINDS)).optional().describe('Restrict to these kinds of memory.'),
    tags: z.array(z.string()).optional().describe('Only entries carrying every one of these tags.'),
    limit: z.number().min(1).max(50).optional().describe('At most this many entries (default 8).')
});

export const memoryRememberInput = z.object({
    text: z.string().min(1).describe('The memory itself, self-contained: it is read later without this conversation.'),
    kind: z.enum(KINDS).describe('fact: verified; preference: what the user wants; assumption: unverified; lesson: what to do differently; record: something that happened.'),
    tags: z.array(z.string()).optional().describe('Tags for later retrieval.'),
    subject: z.string().optional().describe('Who or what the memory is about.'),
    confidence: z.enum(['verified', 'stated', 'assumed']).optional().describe('Default: "stated" for preferences, "assumed" for assumptions, "verified" otherwise.')
});

const DEFAULT_LIMIT = 8;

function defaultConfidence(kind: MemoryKind): NewMemoryEntry['confidence'] {
    if (kind === 'preference') return 'stated';
    if (kind === 'assumption') return 'assumed';
    return 'verified';
}

export function memorySearchTool(port: MemoryPort) {
    return defineTool({
        name: 'memory_search',
        description: 'Search your memory (facts, preferences, lessons, records) for what is relevant now. Returns the best matches with a score.',
        input: memorySearchInput,
        annotations: { readOnly: true, idempotent: true },
        execute: async (input, ctx) => {
            const hits = await port.search(
                {
                    text: input.query,
                    ...(input.kinds ? { kinds: input.kinds } : {}),
                    ...(input.tags ? { tags: input.tags } : {}),
                    limit: input.limit ?? DEFAULT_LIMIT
                },
                { callId: ctx.toolCallId, signal: ctx.signal }
            );
            return {
                memories: hits.map(({ entry, score }) => ({
                    id: entry.id,
                    kind: entry.kind,
                    text: entry.text,
                    tags: entry.tags,
                    confidence: entry.confidence,
                    ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
                    score
                }))
            };
        }
    });
}

export function memoryRememberTool(port: MemoryPort) {
    return defineTool({
        name: 'memory_remember',
        description: 'Store something worth keeping beyond this session: a verified fact, a stated preference, a lesson learned, or a record of what happened. Mark assumptions as assumptions.',
        input: memoryRememberInput,
        annotations: { idempotent: false },
        execute: async (input, ctx) => {
            const entry = await port.remember(
                {
                    kind: input.kind,
                    text: input.text,
                    tags: input.tags ?? [],
                    ...(input.subject !== undefined ? { subject: input.subject } : {}),
                    confidence: input.confidence ?? defaultConfidence(input.kind),
                    provenance: { source: 'agent' }
                },
                { callId: ctx.toolCallId, signal: ctx.signal }
            );
            return { id: entry.id, kind: entry.kind, confidence: entry.confidence };
        }
    });
}
