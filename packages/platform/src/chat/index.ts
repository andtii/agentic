/** Chat actor: membership, addressing, activation rules, history access, file access (architecture §4 Chat, §6). */
export { Chat, defineChatActor, MAX_TITLE_LENGTH, sessionEvents, type ChatOptions, type ChatSummary, type HistoryPage, type Mentions, type PostOptions } from './actor.js';
export { ChatPage, pageKey, type ChatPageState } from './page.js';
export { MAX_PENDING_UPLOADS, PAGE, PENDING_TTL_MS, WINDOW, applyChatEntry, initialChatState, principalKey, visibleFrom, type ChatFileRow, type ChatState, type IndexRow, type IndexedEntry, type PendingUpload } from './state.js';
