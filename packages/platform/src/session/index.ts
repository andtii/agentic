/** Session actor — durable event log, wire serve, resume, task-based driver (architecture §4 Session, §5a/§5b). */
export type { SessionOpenSpec, SessionFactoryContext, OpenedSession, SessionFactory, CommandSink, HistorySource, HistoryTarget, HistoryAnswer, SessionPorts, MemoryRetrievalRecord, AnswerFollowUp } from './ports.js';
export type { SessionStatus, SessionMode, RunningTurn, CommandRecord, SessionState, SessionPatch, SessionEntry, LearningRecord, CorrectionRecord, SessionPageMeta, TranscriptPageMeta, DetachedAnswer, IndexEntry, IndexedTurnStart } from './state.js';
export { MAX_COMMANDS, WINDOW_BYTES, PAGE_BYTES, RETAINED_PAGES, INDEX_TURNS, initialSessionState, applySessionEntry, cursorAfter, currentTaskId, platformCursor, parseSessionKey, eventsAfter, knownEvents, findEvent, requestById, isWholeEvent, bytesOf, jsonBytes, utf8Bytes } from './state.js';
export { SessionPage, sessionPageKey, SESSION_PAGE_TYPE, type SessionPageState } from './page.js';
export { SessionTranscriptPage, transcriptPageKey, SESSION_TRANSCRIPT_PAGE_TYPE, type SessionTranscriptPageState } from './transcript.js';
export type { SessionStoreContext } from './store.js';
export { appendEntry, boundTranscript, createEventLogStore, createTranscriptStore, pageMessages, TRANSCRIPT_BYTES, TRANSCRIPT_PAGE_BYTES } from './store.js';
export type { SessionCommandResult, SessionInfo, SessionActor, CorrectionResult, SessionRequestView, PlatformInputRequest, PlatformRequestRef, DetachedInput } from './actor.js';
export { ANSWER_ATTEMPTS, ANSWER_RETRY_MS, defineSessionActor, isInterruptedTurnEnd, interruptedTurn, resumeTurnId, resumeCommandId, INTERRUPTED_CODE, INTERRUPTED_MESSAGE, HISTORY_GAP_CODE, HISTORY_UNAVAILABLE_CODE, platformRequestId } from './actor.js';
