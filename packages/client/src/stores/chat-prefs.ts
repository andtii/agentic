/**
 * The chat prefs store (#1124): what this viewer chose for each chat on this device, per workspace, over the
 * injected `KeyValueStorage` — so the web and the mobile shell keep the same prefs.
 *
 * - **View prefs** (`agentic:chat-view:<ws>`, #1058, CHT-09): the view they pinned, the detail level they picked
 *   and the turns whose steps box they opened. Never on the Chat actor: another viewer keeps their own.
 * - **Read marks** (`agentic:chat-seen:<ws>`, #152): the chat's `seq` when this device last had it open — what
 *   unread counts against. Marks only move forward.
 *
 * Both load lazily, the first time a workspace is asked for: a page asks after mount (#1113/#1114), so a server
 * render — where storage reads nothing — and the render that hydrates it stay on the defaults. Storage can be
 * missing or refuse: every access is guarded, and without it the choices live for the app only. Workspaces are
 * named per call (the mock chat page reads its sample workspace with no viewer), never by the store's setup.
 */
import { signal } from '@sigx/reactivity';
import { memoryKeyValueStorage, useKeyValueStorage, type KeyValueStorage } from '../storage';
import { defineAppStore } from './define';

export type ChatViewName = 'focus' | 'team' | 'lanes';
/** How much of a turn the thread shows — `@agentic/ui`'s `DetailLevel`, spelled here so the package stays DOM-free. */
export type ChatDetailLevel = 'messages' | 'steps' | 'raw';

export interface ChatViewPrefs {
    /** The view the viewer pinned; absent, the view picks itself. */
    readonly pin?: ChatViewName;
    /** The detail level the viewer picked; absent, the view's default. */
    readonly detail?: ChatDetailLevel;
    /** The messages whose steps box the viewer opened. */
    readonly expanded: readonly string[];
}

/** Chat id → the seq this device has seen it up to (exclusive). */
export type ReadMarks = Readonly<Record<string, number>>;

type ViewStore = Readonly<Record<string, ChatViewPrefs>>;

export const chatViewKey = (ws: string): string => `agentic:chat-view:${ws}`;
export const chatSeenKey = (ws: string): string => `agentic:chat-seen:${ws}`;

const VIEWS: readonly string[] = ['focus', 'team', 'lanes'];
const DETAILS: readonly string[] = ['messages', 'steps', 'raw'];
/** The most opened boxes kept per chat: the newest win. */
export const EXPANDED_CAP = 200;

const EMPTY: ChatViewPrefs = { expanded: [] };
const NO_MARKS: ReadMarks = {};

function record(raw: string | null): Record<string, unknown> {
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function cleanPrefs(value: unknown): ChatViewPrefs | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const pin = typeof v.pin === 'string' && VIEWS.includes(v.pin) ? (v.pin as ChatViewName) : undefined;
    const detail = typeof v.detail === 'string' && DETAILS.includes(v.detail) ? (v.detail as ChatDetailLevel) : undefined;
    const expanded = Array.isArray(v.expanded) ? v.expanded.filter((x): x is string => typeof x === 'string') : [];
    return { ...(pin ? { pin } : {}), ...(detail ? { detail } : {}), expanded };
}

/** Stored view prefs as the store holds them: what it does not know is dropped. */
export function parseViewPrefs(raw: string | null): ViewStore {
    const out: Record<string, ChatViewPrefs> = {};
    for (const [id, prefs] of Object.entries(record(raw))) {
        const c = cleanPrefs(prefs);
        if (c) out[id] = c;
    }
    return out;
}

/** Stored read marks: finite numbers only. */
export function parseReadMarks(raw: string | null): ReadMarks {
    const out: Record<string, number> = {};
    for (const [id, seq] of Object.entries(record(raw))) if (typeof seq === 'number' && Number.isFinite(seq)) out[id] = seq;
    return out;
}

/** An injectable the app may not provide (a test page, a host with nowhere to persist): `null` then. */
function optional<T>(use: () => T): T | null {
    try {
        return use();
    } catch {
        return null;
    }
}

export const useChatPrefsStore = defineAppStore('chat-prefs', () => {
    const storage: KeyValueStorage = optional(useKeyValueStorage) ?? memoryKeyValueStorage();
    /** Every workspace's view prefs read so far (a mock and a live page can both be mounted). */
    const views = signal<{ loaded: Readonly<Record<string, ViewStore>> }>({ loaded: {} });
    /** The read marks of the one workspace loaded. */
    const seen = signal<{ ws: string | null; marks: ReadMarks }>({ ws: null, marks: NO_MARKS });

    const load = (key: string): string | null => {
        try {
            return storage.get(key);
        } catch {
            return null;
        }
    };
    const save = (key: string, value: unknown): void => {
        try {
            storage.set(key, JSON.stringify(value));
        } catch {
            // Kept in memory for this app.
        }
    };
    const loadViews = (ws: string): ViewStore => {
        const held = views.loaded[ws];
        if (held) return held;
        const store = parseViewPrefs(load(chatViewKey(ws)));
        views.loaded = { ...views.loaded, [ws]: store };
        return store;
    };
    const change = (ws: string, chatId: string, next: (prev: ChatViewPrefs) => ChatViewPrefs): void => {
        const store = loadViews(ws);
        const updated: ViewStore = { ...store, [chatId]: next(store[chatId] ?? EMPTY) };
        views.loaded = { ...views.loaded, [ws]: updated };
        save(chatViewKey(ws), updated);
    };
    const loadReadMarks = (ws: string): void => {
        if (seen.ws === ws) return;
        seen.ws = ws;
        seen.marks = parseReadMarks(load(chatSeenKey(ws)));
    };
    const moveMarks = (ws: string, marks: ReadMarks): void => {
        seen.marks = marks;
        save(chatSeenKey(ws), marks);
    };

    return {
        /** The viewer's choices for a chat; reactive. Reads storage the first time a workspace is asked for. */
        viewPrefs: (ws: string, chatId: string): ChatViewPrefs => loadViews(ws)[chatId] ?? EMPTY,
        /** Pin a view; `undefined` unpins it, so the view picks itself again. */
        setViewPin(ws: string, chatId: string, pin: ChatViewName | undefined): void {
            change(ws, chatId, ({ pin: _old, ...rest }) => (pin ? { ...rest, pin } : rest));
        },
        /** Save the detail level the viewer picked. */
        setViewDetail(ws: string, chatId: string, detail: ChatDetailLevel): void {
            change(ws, chatId, (prev) => ({ ...prev, detail }));
        },
        /** Remember a message's steps box open (or forget it, closed). */
        setStepsExpanded(ws: string, chatId: string, messageId: string, open: boolean): void {
            change(ws, chatId, (prev) => {
                const rest = prev.expanded.filter((id) => id !== messageId);
                const expanded = open ? [...rest, messageId].slice(-EXPANDED_CAP) : rest;
                return { ...prev, expanded };
            });
        },
        /** Load the workspace's read marks — call on the client only (after mount), so a server render counts nothing unread. */
        loadReadMarks,
        /** The loaded marks of `ws`; reactive. Empty until `loadReadMarks(ws)` ran. */
        readMarks: (ws: string | null): ReadMarks => (ws !== null && seen.ws === ws ? seen.marks : NO_MARKS),
        /** This device has seen the chat up to `seq` (exclusive). Never moves a mark back. */
        markSeen(ws: string, chatId: string, seq: number): void {
            loadReadMarks(ws);
            const current = seen.marks[chatId];
            if (current !== undefined && current >= seq) return;
            moveMarks(ws, { ...seen.marks, [chatId]: seq });
        },
        /** First sight of chats on this device: each without a mark starts at its current `seq`, so only what arrives from now on counts as unread. */
        baselineReadMarks(ws: string, chats: readonly { readonly id: string; readonly seq: number }[]): void {
            loadReadMarks(ws);
            const missing = chats.filter((c) => seen.marks[c.id] === undefined);
            if (!missing.length) return;
            moveMarks(ws, { ...seen.marks, ...Object.fromEntries(missing.map((c) => [c.id, c.seq])) });
        }
    };
});
