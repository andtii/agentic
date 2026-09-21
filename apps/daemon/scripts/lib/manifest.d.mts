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
    readonly publishedAt: string;
    readonly commit: string;
    readonly protocol: number;
    readonly notesUrl: string;
    readonly assets: Readonly<Record<string, ManifestAsset>>;
    readonly harnesses: Readonly<Record<string, never>>;
}
export function readSidecar(file: string): string;
export function buildManifest(input: {
    readonly dir: string;
    readonly tag: string;
    readonly repo: string;
    readonly stamp: { readonly version: string; readonly commit: string; readonly channel: 'stable' | 'latest' };
    readonly protocol: number;
    readonly publishedAt?: string;
}): Manifest;
