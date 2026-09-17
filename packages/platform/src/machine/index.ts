/** Machine actor — a paired daemon's record, its hibernatable socket protocol, capacity queue and pending replies (architecture §4 Machine, §5b). */
export type { MachineSocketPort, ToolCallInput, ToolCallPort, MachinePorts } from './ports.js';
export { ToolCallError } from './ports.js';
export type { MachineOs, HostedSession, QueuedSession, PendingCommand, SessionClosure, MachineState } from './state.js';
export { MACHINE_STATE_VERSION, MAX_CLOSURES, initialMachineState, machineKey, parseMachineKey, activeIn, freeSlots } from './state.js';
export type { PairInfo, PairedMachine, OpenSessionResult, OpenSessionOptions, SocketMessageResult, MachineView, MachineActor } from './actor.js';
export { defineMachineActor, toAgentCapabilities, LIVENESS, DEFAULT_HEARTBEAT_WINDOW_MS, DEFAULT_COMMAND_TIMEOUT_MS } from './actor.js';
