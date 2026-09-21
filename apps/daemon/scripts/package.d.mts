// Types for scripts/package.mjs (JS with JSDoc; this file keeps the test typed).
export interface PackageOptions {
    readonly outDir?: string;
    /** Name the zip `agentic-daemon-<os>-<arch>.zip` (no version): the release asset the installers fetch. */
    readonly unversioned?: boolean;
    /** Also write `<zip>.sha256` (`<hex>  <zip name>`) beside the zip. */
    readonly sha256?: boolean;
    readonly log?: (line: string) => void;
}
export interface PackageResult {
    readonly zipFile: string;
    readonly version: string;
    readonly entries: number;
    readonly bytes: number;
    readonly packages: number;
    /** The zip's sha256 (hex), with `sha256: true`. */
    readonly sha256?: string;
}
export interface ClosureSource {
    readonly real: string;
    readonly name: string;
    readonly version: string;
    readonly workspace: boolean;
}
export function packageDaemon(options?: PackageOptions): PackageResult;
export function resolveClosure(rootDir: string): Map<string, ClosureSource>;
