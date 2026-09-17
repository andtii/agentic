/**
 * The compile-time dev flag `defineLibConfig` (build) and vitest define; `false`
 * in the prod dist. A module, not a `.d.ts`: the repo ignores `*.d.ts` as build output.
 */
declare global {
    const __DEV__: boolean;
}
export {};
