/** Chat actor: membership, addressing, activation rules, history access (architecture §4 Chat, §6). */
export { Chat, sessionEvents, type ChatSummary, type HistoryPage, type Mentions, type PostOptions } from './actor.js';
export { ChatPage, pageKey, type ChatPageState } from './page.js';
export { PAGE, WINDOW, applyChatEntry, initialChatState, visibleFrom, type ChatState, type IndexRow, type IndexedEntry } from './state.js';
