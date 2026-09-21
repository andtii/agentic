// Types for scripts/supervise.mjs (JS with JSDoc; this file keeps the test typed).
export const SUPERVISOR_VERSION: string;
export const EXIT_UPDATE: 75;
export interface SupervisorTimings {
    readonly backoffInitialMs: number;
    readonly backoffMaxMs: number;
    readonly backoffResetMs: number;
    readonly readyTimeoutMs: number;
    readonly crashWindowMs: number;
    readonly stopTimeoutMs: number;
    readonly renameRetryMs: number;
    readonly readyPollMs: number;
}
export interface SupervisorArgs {
    readonly root?: string;
    readonly log?: string;
    readonly daemon?: string;
    readonly version?: boolean;
    readonly help?: boolean;
    readonly timings: SupervisorTimings;
    readonly error?: string;
}
export function parseSupervisorArgs(argv: readonly string[]): SupervisorArgs;
export interface SupervisorLayout {
    readonly root: string;
    readonly daemonDir: string;
    readonly staged: string;
    readonly prev: string;
    readonly failed: string;
    entry(dir: string): string;
    readonly state: string;
    readonly ready: string;
    readonly status: string;
    readonly updateFailed: string;
    readonly log: string;
}
export function supervisorLayout(root: string, daemon?: string): SupervisorLayout;
export function supervise(options: { root: string; log?: string; daemon?: string; timings?: Partial<SupervisorTimings>; signals?: boolean }): Promise<number>;
