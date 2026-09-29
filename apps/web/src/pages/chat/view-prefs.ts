/**
 * What this viewer chose for each chat (#1058, CHT-09; `docs/decisions.md` 2026-09-28 §2): the view they pinned,
 * the detail level they picked and the turns whose steps box they opened — per workspace and chat, on this
 * device. The state lives in `@agentic/client`'s chat prefs store (#1124) over the app's `KeyValueStorage`
 * (`localStorage` on the web), so the mobile shell keeps the same prefs; read it in a component's setup with
 * `useViewPrefs()`.
 */
import { useChatPrefsStore, type ChatViewName, type ChatViewPrefs } from '@agentic/client';

export { EXPANDED_CAP } from '@agentic/client';
export type { ChatViewName, ChatViewPrefs };

/** The chat prefs store: `viewPrefs`, `setViewPin`, `setViewDetail`, `setStepsExpanded`. Call it in setup. */
export const useViewPrefs = useChatPrefsStore;
