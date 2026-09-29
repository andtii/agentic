/**
 * Where this device last had each chat open (#152): the chat's `seq` at that moment, per workspace — what
 * `unreadOf` counts against. Device-local on purpose: chat state is a replayed entry log, so a marker there
 * would need a new core entry kind and would spend the window on non-content; read state that follows the
 * user across devices is #157. Marks only move forward.
 *
 * The marks live in `@agentic/client`'s chat prefs store (#1124) over the app's `KeyValueStorage`; read it in a
 * component's setup with `useReadMarks()` and load a workspace's marks on the client only (`onMounted`), so a
 * server render counts nothing unread.
 */
import { useChatPrefsStore } from '@agentic/client';

export type { ReadMarks } from '@agentic/client';

/** The chat prefs store: `loadReadMarks`, `readMarks`, `markSeen`, `baselineReadMarks`. Call it in setup. */
export const useReadMarks = useChatPrefsStore;
