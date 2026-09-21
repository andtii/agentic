// Types for scripts/lib/manifest.mjs.
export interface ManifestAsset {
    readonly url: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly version: string;
}
export interface Manifest {
    readonly version: string;
    readonly channel: 'stable' | 'latest';
    /** Epoch ms. */
    readonly publishedAt: number;
    readonly commit: string;
    readonly protocol: number;
    readonly notesUrl: string;
    readonly assets: Readonly<Record<string, ManifestAsset>>;
    /** By runtime: the harness zips of the release (#369). */
    readonly harnesses: Readonly<Record<string, { readonly version: string; readonly assets: Readonly<Record<string, ManifestAsset>> }>>;
}
export function readSidecar(file: string): string;
export function buildManifest(input: {
    readonly dir: string;
    readonly tag: string;
    readonly repo: string;
    readonly stamp: { readonly version: string; readonly commit: string; readonly channel: 'stable' | 'latest' };
    readonly protocol: number;
    readonly publishedAt?: number;
    /** #441: runtime → the version this build pins; each runtime is then listed for every platform, carried over from `previous` when not packaged. */
    readonly harnessVersions?: Readonly<Record<string, string>>;
    readonly previous?: { readonly harnesses?: Readonly<Record<string, { readonly version?: unknown; readonly assets?: Readonly<Record<string, ManifestAsset>> }>> };
    /** The release's asset names. */
    readonly existing?: readonly string[];
}): Manifest;
/** The runtimes whose zip for its version (or the zip's `.sha256`) is not among `existing` on `platform`. */
export function planHarnesses(input: { readonly versions: Readonly<Record<string, string>>; readonly existing: readonly string[]; readonly platform: string }): string[];
/** The `harness-*.zip(.sha256)` assets among `existing` that `manifest` does not point at. */
export function staleHarnessAssets(input: { readonly existing: readonly string[]; readonly manifest: { readonly harnesses?: Readonly<Record<string, { readonly assets?: Readonly<Record<string, { readonly url: string }>> }>> } }): string[];
