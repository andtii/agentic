/** Session actor — durable event log, wire serve, resume, task-based driver (architecture §4 Session, §5a/§5b). */
export type { SessionOpenSpec, SessionFactoryContext, OpenedSession, SessionFactory, CommandSink, SessionPorts, MemoryRetrievalRecord } from './ports.js';
export type { SessionStatus, SessionMode, RunningTurn, CommandRecord, SessionState, SessionPatch, SessionEntry, LearningRecord, CorrectionRecord, SessionPageMeta } from './state.js';
export { MAX_COMMANDS, WINDOW_BYTES, PAGE_BYTES, initialSessionState, applySessionEntry, cursorAfter, platformCursor, parseSessionKey, eventsAfter, knownEvents, bytesOf } from './state.js';
export { SessionPage, sessionPageKey, SESSION_PAGE_TYPE, type SessionPageState } from './page.js';
export type { SessionStoreContext } from './store.js';
export { appendEntry, boundTranscript, createEventLogStore, createTranscriptStore, TRANSCRIPT_BYTES } from './store.js';
export type { SessionCommandResult, SessionInfo, SessionActor, CorrectionResult, SessionRequestView, PlatformInputRequest, PlatformRequestRef } from './actor.js';
export { defineSessionActor, isInterruptedTurnEnd, interruptedTurn, resumeTurnId, resumeCommandId, INTERRUPTED_CODE, INTERRUPTED_MESSAGE, platformRequestId } from './actor.js';
