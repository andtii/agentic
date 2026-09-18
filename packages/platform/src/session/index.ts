/** Session actor — durable event log, wire serve, resume, task-based driver (architecture §4 Session, §5a/§5b). */
export type { SessionOpenSpec, SessionFactoryContext, OpenedSession, SessionFactory, CommandSink, SessionPorts, MemoryRetrievalRecord } from './ports.js';
export type { SessionStatus, SessionMode, RunningTurn, CommandRecord, SessionState, SessionPatch, SessionEntry, LearningRecord, CorrectionRecord } from './state.js';
export { MAX_COMMANDS, initialSessionState, applySessionEntry, cursorAfter, platformCursor, parseSessionKey, eventsAfter } from './state.js';
export type { SessionStoreContext } from './store.js';
export { appendEntry, createEventLogStore, createTranscriptStore } from './store.js';
export type { SessionCommandResult, SessionInfo, SessionActor, CorrectionResult, SessionRequestView, PlatformInputRequest, PlatformRequestRef } from './actor.js';
export { defineSessionActor, isInterruptedTurnEnd, interruptedTurn, resumeTurnId, resumeCommandId, INTERRUPTED_CODE, INTERRUPTED_MESSAGE, platformRequestId } from './actor.js';
