/**
 * The chat's saved view choices in tests (#1058): a test that reads every tool card sets the chat's detail
 * to Raw first (a multi-agent chat defaults to Team's Messages); `clearViewPrefs` forgets every choice.
 */
import type { DetailLevel } from '@agentic/ui';
import { USER } from '../../src/mock/workspace';
import { resetViewPrefs, setViewDetail } from '../../src/pages/chat/view-prefs';

/** Save `detail` for a mock chat, as the viewer picking it in the header would. */
export function saveDetail(chatId: string, detail: DetailLevel, ws: string = USER.workspace): void {
    setViewDetail(ws, chatId, detail);
}

/** Forget every saved choice: storage and the loaded copy. */
export function clearViewPrefs(): void {
    try {
        globalThis.localStorage?.clear();
    } catch {
        // No storage: the loaded copy is all there is.
    }
    resetViewPrefs();
}
