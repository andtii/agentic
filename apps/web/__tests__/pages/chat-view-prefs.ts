/**
 * The chat's saved view choices in tests (#1058): a test that reads every tool card sets the chat's detail
 * to Raw first (a multi-agent chat defaults to Team's Messages); `clearViewPrefs` forgets every choice.
 * The choices live in the app's chat prefs store (#1124), which reads storage when a page first asks — so a
 * test saves them to storage before it mounts, and every mount is a fresh app.
 */
import type { DetailLevel } from '@agentic/ui';
import { chatViewKey, parseViewPrefs, type ChatViewName } from '@agentic/client';
import { USER } from '../../src/mock/workspace';

function save(ws: string, chatId: string, change: { pin?: ChatViewName; detail?: DetailLevel }): void {
    const store = parseViewPrefs(globalThis.localStorage.getItem(chatViewKey(ws)));
    globalThis.localStorage.setItem(chatViewKey(ws), JSON.stringify({ ...store, [chatId]: { ...(store[chatId] ?? { expanded: [] }), ...change } }));
}

/** Save `detail` for a mock chat, as the viewer picking it in the header would. */
export function saveDetail(chatId: string, detail: DetailLevel, ws: string = USER.workspace): void {
    save(ws, chatId, { detail });
}

/** Save a pinned view for a mock chat. */
export function savePin(chatId: string, pin: ChatViewName, ws: string = USER.workspace): void {
    save(ws, chatId, { pin });
}

/** Forget every saved choice. */
export function clearViewPrefs(): void {
    try {
        globalThis.localStorage?.clear();
    } catch {
        // No storage: nothing is kept.
    }
}
