export { FRAME_ERROR_CODES, DaemonProtocolError } from './errors.js';
export type { FrameErrorCode, FrameIssue, FrameError } from './errors.js';
export { frameBytes, parseDaemonFrame, parsePlatformFrame, decodeDaemonFrame, decodePlatformFrame, encodeFrame } from './codec.js';
export type { RawMessage, DecodeResult, FramingOptions } from './codec.js';
