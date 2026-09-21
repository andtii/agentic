/** ReleaseDirectory — the global cache of the daemon release manifests every Machine compares its build against (architecture §4, #365). */
export {
    ReleaseDirectory,
    defineReleaseDirectory,
    parseReleaseManifest,
    platformVersion,
    RELEASE_DIRECTORY_KEY,
    RELEASE_DIRECTORY_TYPE,
    RELEASE_SOURCES,
    RELEASE_REFRESH_MS,
    RELEASE_CHECK_MIN_MS,
    RELEASE_FETCH_TIMEOUT_MS,
    RELEASE_MANIFEST_MAX_BYTES,
    MIN_DAEMON_VERSION,
    PLATFORM_VERSION,
    type ReleaseDirectoryActor,
    type ReleaseDirectoryOptions,
    type ReleaseDirectoryState,
    type ReleasesView
} from './directory.js';
