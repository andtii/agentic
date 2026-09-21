// Types for scripts/lib/stamp.mjs.
export interface BuildStamp {
    readonly version: string;
    /** Seven hex digits, or `unknown`. */
    readonly commit: string;
    readonly channel: 'stable' | 'latest';
    /** The release tag (`daemon-v<semver>`), `null` off a tag. */
    readonly tag: string | null;
}
export const RELEASE_TAG: RegExp;
/** `committedAt`: the commit's unix seconds; a main build's version is `<package version>-main.<committedAt>.<sha7>` (0 when absent). */
export function buildStamp(input: { readonly tag?: string | undefined; readonly packageVersion: string; readonly commit: string; readonly committedAt?: number | undefined }): BuildStamp;
export function releaseTagFrom(env: Readonly<Record<string, string | undefined>>): string | undefined;
export function currentCommit(cwd: string, env: Readonly<Record<string, string | undefined>>): string;
export function commitTime(cwd: string, commit: string): number;
export function stampFor(daemonDir: string, env?: Readonly<Record<string, string | undefined>>): BuildStamp;
export function protocolVersion(repoRoot: string): number;
