/**
 * @agentic/daemon — the machine daemon (architecture §5b): pair a machine to
 * a workspace, report its environments, serve runtime sessions and bridge
 * platform tool calls over one reconnecting WebSocket. Node-only by design.
 */
export { DAEMON_VERSION } from './version.js';
export { main, parseArgs, type CliContext, type ParsedArgs } from './cli.js';
export { createDaemon, agentCapabilitiesOf, follows, PlatformToolError, type Daemon, type DaemonDriver, type DaemonOptions } from './daemon.js';
export { answerFsRequest, checkWithinRoots, gitInfo, withinRoots, type FsOptions, type FsOutcome, type RootCheck } from './fs.js';
export { builtinDrivers, isDisposable, type DisposableDriver } from './drivers.js';
export { runDoctor, formatDoctorReport, type DoctorOptions } from './doctor.js';
export { parseEnvironments, loadEnvironments, type EnvironmentsResult } from './environments.js';
export {
    addEnvironment,
    removeEnvironment,
    putEnvironment,
    deleteEnvironment,
    writeEnvironments,
    readEnvironmentsForEdit,
    watchEnvironments,
    profileDirFor,
    newEnvironmentId,
    EnvironmentStoreError,
    type EnvironmentInput,
    type EnvironmentStoreErrorCode,
    type PutOptions,
    type WatchEnvironmentsOptions
} from './env-store.js';
export { envCommand, flagValues, loginEnv, runLogin, ENV_USAGE, type EnvCommandContext, type LoginRunner } from './env-cli.js';
export { ndjsonEventLog, type NdjsonEventLog, type NdjsonEventLogOptions } from './event-log.js';
export { reconnectingConnection, backoffDelay, type BackoffOptions, type Connection, type ConnectionHandlers, type ConnectionOptions, type Socket } from './connection.js';
export { pair, normalizePlatformUrl, normalizePairingCode, daemonSocketUrl, PairingError, type PairOptions, type PairResult } from './pair.js';
export { saveCredentials, loadCredentials, writeOwnerOnly, ownerOnlyAclArgs, credentialSecrets, runCommand, type Credentials, type CommandRunner, type CommandResult, type SecureWriteOptions } from './credentials.js';
export { createLogger, redact, silentLogger, type Logger, type LoggerOptions, type LogLevel, type LogFields } from './logger.js';
export { daemonPaths, type DaemonPaths, type PathContext } from './paths.js';
