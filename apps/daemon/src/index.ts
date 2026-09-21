/**
 * @agentic/daemon — the machine daemon (architecture §5b): pair a machine to
 * a workspace, report its environments, serve runtime sessions and bridge
 * platform tool calls over one reconnecting WebSocket. Node-only by design.
 */
export { DAEMON_VERSION } from './version.js';
export { main, parseArgs, type CliContext, type ParsedArgs } from './cli.js';
export { createDaemon, withoutLocalPaths, agentCapabilitiesOf, follows, PlatformToolError, DEFAULT_LOG_MAX_BYTES, HISTORY_RESPONSE_BYTES, HARNESS_DRAIN_TIMEOUT_MS, type Daemon, type DaemonDriver, type DaemonHarnesses, type DaemonOptions } from './daemon.js';
export { answerFsRequest, checkWithinRoots, gitInfo, withinRoots, type FsOptions, type FsOutcome, type RootCheck } from './fs.js';
export { builtinDrivers, builtinRuntimes, harnessMissingDriver, isDisposable, type BuiltinRuntimes, type BuiltinRuntimesOptions, type DisposableDriver } from './drivers.js';
export { runDoctor, formatDoctorReport, whichOnPath, type DoctorOptions } from './doctor.js';
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
    type WatchEnvironmentsOptions,
    watchConfigFile,
    type WatchConfigFileOptions
} from './env-store.js';
export { answerEnvRequest, type EnvManageContext, type EnvOutcome } from './env-manage.js';
export {
    POLICY_OFF,
    parsePolicy,
    loadPolicy,
    writePolicy,
    watchPolicy,
    reportedPolicy,
    allowRoot,
    denyRoot,
    checkWorkingRoot,
    isRemoteOrDevicePath,
    PolicyError,
    type PolicyErrorCode,
    type PolicyResult,
    type ProtectedDirs,
    type WorkingRootCheck
} from './policy.js';
export { policyCommand, describePolicy, POLICY_USAGE, type PolicyCommandContext } from './policy-cli.js';
export { envCommand, flagValues, loginEnv, runLogin, ENV_USAGE, type EnvCommandContext, type LoginRunner } from './env-cli.js';
export { ndjsonEventLog, reachesBack, type NdjsonEventLog, type NdjsonEventLogOptions, type RetentionPolicy, type HistorySlice } from './event-log.js';
export { reconnectingConnection, backoffDelay, type BackoffOptions, type Connection, type ConnectionHandlers, type ConnectionOptions, type Socket } from './connection.js';
export { pair, normalizePlatformUrl, normalizePairingCode, daemonSocketUrl, PairingError, type PairOptions, type PairResult } from './pair.js';
export { saveCredentials, loadCredentials, writeOwnerOnly, ownerOnlyAclArgs, credentialSecrets, runCommand, type Credentials, type CommandRunner, type CommandResult, type SecureWriteOptions } from './credentials.js';
export { createLogger, redact, silentLogger, type Logger, type LoggerOptions, type LogLevel, type LogFields } from './logger.js';
export { daemonPaths, type DaemonPaths, type PathContext } from './paths.js';
export {
    harnessStore,
    harnessRoot,
    bundledHarness,
    sdkVersion,
    treeHashOf,
    extractZipFile,
    parseHarnessManifest,
    releaseManifestUrl,
    fetchReleaseManifest,
    harnessAsset,
    HarnessError,
    HarnessMissingError,
    BUILTIN_HARNESSES,
    DEFAULT_RELEASES,
    type HarnessStore,
    type HarnessStoreOptions,
    type HarnessLocator,
    type HarnessLocation,
    type HarnessState,
    type HarnessSpec,
    type HarnessPackageManifest,
    type StageOptions,
    type StagedHarness
} from './harness.js';
export { harnessCommand, harnessManifestUrl, HARNESS_USAGE, type HarnessCommandContext } from './harness-cli.js';
