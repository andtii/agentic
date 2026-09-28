/**
 * What this viewer chose for each chat (#1058, CHT-09; `docs/decisions.md` 2026-09-28 §2): the view they
 * pinned, the detail level they picked and the turns whose steps box they opened — per workspace and chat,
 * in `localStorage`, like `read-marks.ts`. Never on the Chat actor: another viewer keeps their own.
 *
 * Storage can be missing or refuse (a server render, a private window, blocked site data): every access is
 * guarded, and without it the choices live for the page only.
 */
import { signal } from 'sigx';
import type { DetailLevel } from '@agentic/ui';

export type ChatViewName = 'focus' | 'team' | 'lanes';

export interface ChatViewPrefs {
    /** The view the viewer pinned; absent, the view picks itself (`views/pick.ts`). */
    readonly pin?: ChatViewName;
    /** The detail level the viewer picked; absent, the view's default. */
    readonly detail?: DetailLevel;
    /** The messages whose steps box the viewer opened. */
    readonly expanded: readonly string[];
}

type Store = Readonly<Record<string, ChatViewPrefs>>;

const storageKey = (ws: string): string => `agentic:chat-view:${ws}`;
const VIEWS: readonly string[] = ['focus', 'team', 'lanes'];
const DETAILS: readonly string[] = ['messages', 'steps', 'raw'];
/** The most opened boxes kept per chat: the newest win. */
export const EXPANDED_CAP = 200;

const EMPTY: ChatViewPrefs = { expanded: [] };

/** Every workspace read so far (a mock and a live page can both be mounted), by workspace. */
const state = signal<{ loaded: Readonly<Record<string, Store>> }>({ loaded: {} });

function clean(value: unknown): ChatViewPrefs | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const pin = typeof v.pin === 'string' && VIEWS.includes(v.pin) ? (v.pin as ChatViewName) : undefined;
    const detail = typeof v.detail === 'string' && DETAILS.includes(v.detail) ? (v.detail as DetailLevel) : undefined;
    const expanded = Array.isArray(v.expanded) ? v.expanded.filter((x): x is string => typeof x === 'string') : [];
    return { ...(pin ? { pin } : {}), ...(detail ? { detail } : {}), expanded };
}

function read(ws: string): Store {
    try {
        const raw = globalThis.localStorage?.getItem(storageKey(ws));
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, ChatViewPrefs> = {};
        for (const [id, prefs] of Object.entries(parsed)) {
            const c = clean(prefs);
            if (c) out[id] = c;
        }
        return out;
    } catch {
        return {};
    }
}

function write(ws: string, store: Store): void {
    try {
        globalThis.localStorage?.setItem(storageKey(ws), JSON.stringify(store));
    } catch {
        // Kept in memory for this page.
    }
}

function load(ws: string): Store {
    const held = state.loaded[ws];
    if (held) return held;
    const store = read(ws);
    state.loaded = { ...state.loaded, [ws]: store };
    return store;
}

/** The viewer's choices for a chat; reactive. Reads storage the first time a workspace is asked for. */
export function viewPrefs(ws: string, chatId: string): ChatViewPrefs {
    return load(ws)[chatId] ?? EMPTY;
}

function change(ws: string, chatId: string, next: (prev: ChatViewPrefs) => ChatViewPrefs): void {
    const store = load(ws);
    const updated: Store = { ...store, [chatId]: next(store[chatId] ?? EMPTY) };
    state.loaded = { ...state.loaded, [ws]: updated };
    write(ws, updated);
}

/** Pin a view; `undefined` unpins it, so the view picks itself again. */
export function setViewPin(ws: string, chatId: string, pin: ChatViewName | undefined): void {
    change(ws, chatId, ({ pin: _old, ...rest }) => (pin ? { ...rest, pin } : rest));
}

/** Save the detail level the viewer picked. */
export function setViewDetail(ws: string, chatId: string, detail: DetailLevel): void {
    change(ws, chatId, (prev) => ({ ...prev, detail }));
}

/** Remember a message's steps box open (or forget it, closed). */
export function setStepsExpanded(ws: string, chatId: string, messageId: string, open: boolean): void {
    change(ws, chatId, (prev) => {
        const rest = prev.expanded.filter((id) => id !== messageId);
        const expanded = open ? [...rest, messageId].slice(-EXPANDED_CAP) : rest;
        return { ...prev, expanded };
    });
}

/** Test seam: forget every loaded workspace, so the next read goes to storage again. */
export function resetViewPrefs(): void {
    state.loaded = {};
}
