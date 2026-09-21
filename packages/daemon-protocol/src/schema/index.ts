/**
 * Validators for every frame on the daemon socket. Each one is a zod schema
 * and therefore a Standard Schema (`schema['~standard'].validate(value)`), so
 * any Standard-Schema-aware caller can use them without touching zod.
 */

export { LIMITS } from './limits.js';
export { cursor, cursors, platformCursor, environment, capabilityReport, openSpec, openSpecConnector, openSpecPolicy, approvalRule, toolGrant, fsOp, fsResult, fsError, environmentInput, envResult, envError, machinePolicy, quotaWindow, quotaSnapshot } from './common.js';
export { sessionRef, agentCapabilities, agentEvent, promptPart, decision, outputSpec, wireFrame, wireEventFrame, wireReply, wireCommand } from './wire.js';
export {
    helloFrame,
    envFrame,
    heartbeatFrame,
    sessionOpenedFrame,
    sessionFrameFrame,
    sessionReplyFrame,
    sessionClosedFrame,
    toolCallFrame,
    pongFrame,
    fsResponseFrame,
    envResponseFrame,
    quotaFrame,
    historyResponseFrame,
    daemonFrameSchemas,
    daemonFrame
} from './daemon.js';
export { welcomeFrame, sessionOpenFrame, sessionCommandFrame, sessionCloseFrame, toolResultFrame, pingFrame, fsRequestFrame, envRequestFrame, historyRequestFrame, platformFrameSchemas, platformFrame } from './platform.js';
