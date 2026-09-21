// Types for scripts/lib/harness.mjs.
export interface HarnessSpec {
    readonly sdk: string;
    readonly native: (key: string) => string;
    readonly binary: (key: string) => string;
}
export const CODEX_TRIPLES: Readonly<Record<string, string>>;
export const HARNESSES: Readonly<Record<string, HarnessSpec>>;
export function isNativeHarnessPackage(name: string): boolean;
export function treeHash(files: Iterable<[string, string]>): string;
export const HARNESS_ZIP: RegExp;
