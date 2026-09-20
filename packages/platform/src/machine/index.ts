/** Machine actor — a paired daemon's record, its hibernatable socket protocol, capacity queue, pending replies, folder requests and environment requests (architecture §4 Machine, §5b). */
export type { MachineSocketPort, ToolCallInput, ToolCallPort, MachinePorts } from './ports.js';
export { ToolCallError } from './ports.js';
export type { MachineOs, HostedSession, QueuedSession, PendingCommand, FsRequestRecord, EnvRequestRecord, SessionClosure, MachineState, CapacityView } from './state.js';
export { MACHINE_STATE_VERSION, MAX_CLOSURES, MAX_FS_REQUESTS, FS_RESULT_TTL_MS, MAX_ENV_REQUESTS, ENV_RESULT_TTL_MS, initialMachineState, machineKey, parseMachineKey, activeIn, freeSlots, hostedIn, runningIn, pruneQuota } from './state.js';
export type { PairInfo, PairedMachine, OpenSessionResult, OpenSessionOptions, SocketMessageResult, MachineView, MachineActor, EnvironmentDoctorView, MachineDoctorView, FsRequested, FsResultView, EnvRequested, EnvResultView, EnvironmentQuotaView, MachineQuotaView } from './actor.js';
export { usageLimitsOf } from './usage.js';
export { defineMachineActor, toAgentCapabilities, LIVENESS, DEFAULT_HEARTBEAT_WINDOW_MS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_FS_TIMEOUT_MS, DEFAULT_ENV_TIMEOUT_MS, MACHINE_OFFLINE_CODE } from './actor.js';
