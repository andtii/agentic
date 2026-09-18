/**
 * Failure distinction and recovery (#46; OPS-04, OPS-05): the pure signal
 * → state mapping (`failureOf`), this browser's connection signal, the
 * card with its actions wired (`FailureNotice`) and the shell's live
 * connection strip. The named cards themselves are the design track's
 * (`@agentic/ui` `kit/states`); nothing here duplicates them.
 */
export { failureOf, taskFailureKind, authUnavailable, isResumeWait, INTERRUPTED_CODE } from './failure';
export type { FailureSignals, FailureState, ClientConnection, SessionSignalState } from './failure';
export { clientConnection, setClientConnection, watchTransport, installClientConnection } from './client';
export { FailureNotice, failureAction, UNCERTAIN_LINE } from './FailureNotice';
export type { FailureNoticeProps } from './FailureNotice';
export { LiveConnection, machineRowsOf, ageLabel } from './LiveConnection';
export type { MachinePresence } from './LiveConnection';
