/**
 * Where this device last had each chat open (#152): the chat's `seq` at
 * that moment, per workspace, in `localStorage` — what `unreadOf` counts
 * against. Device-local on purpose: chat state is a replayed entry log, so a
 * marker there would need a new core entry kind and would spend the window
 * on non-content; read state that follows the user across devices is #157.
 *
 * Storage can be missing or refuse (a server render, a private window,
 * blocked site data): every access is guarded, and without it the marks
 * live for the page only. Marks only move forward.
 */
import { signal } from 'sigx';

export type ReadMarks = Readonly<Record<string, number>>;

const storageKey = (ws: string): string => `agentic:chat-seen:${ws}`;

const state = signal<{ ws: string | null; marks: ReadMarks }>({ ws: null, marks: {} });

function read(ws: string): ReadMarks {
    try {
        const raw = globalThis.localStorage?.getItem(storageKey(ws));
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [id, seq] of Object.entries(parsed)) if (typeof seq === 'number' && Number.isFinite(seq)) out[id] = seq;
        return out;
    } catch {
        return {};
    }
}

function write(ws: string, marks: ReadMarks): void {
    try {
        globalThis.localStorage?.setItem(storageKey(ws), JSON.stringify(marks));
    } catch {
        // Kept in memory for this page.
    }
}

/** Load the workspace's marks — call on the client only (`onMounted`), so a server render counts nothing unread. */
export function loadReadMarks(ws: string): void {
    if (state.ws === ws) return;
    state.ws = ws;
    state.marks = read(ws);
}

/** The loaded marks of `ws`; reactive. Empty until `loadReadMarks(ws)` ran. */
export const readMarks = (ws: string | null): ReadMarks => (ws !== null && state.ws === ws ? state.marks : {});

/** This device has seen the chat up to `seq` (exclusive). Never moves a mark back. */
export function markSeen(ws: string, chatId: string, seq: number): void {
    loadReadMarks(ws);
    const current = state.marks[chatId];
    if (current !== undefined && current >= seq) return;
    state.marks = { ...state.marks, [chatId]: seq };
    write(ws, state.marks);
}

/**
 * First sight of chats on this device: each without a mark starts at its
 * current `seq`, so only what arrives from now on counts as unread.
 */
export function baselineReadMarks(ws: string, chats: readonly { readonly id: string; readonly seq: number }[]): void {
    loadReadMarks(ws);
    const missing = chats.filter((c) => state.marks[c.id] === undefined);
    if (!missing.length) return;
    state.marks = { ...state.marks, ...Object.fromEntries(missing.map((c) => [c.id, c.seq])) };
    write(ws, state.marks);
}

/** Test seam: forget the loaded workspace, so the next load reads storage again. */
export function resetReadMarks(): void {
    state.ws = null;
    state.marks = {};
}
