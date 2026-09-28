/**
 * VENDORED from signalxjs/actors `packages/actors/src/testing/conformance.ts` at v0.11.0,
 * imports rewritten to the published `@sigx/actors` entry. The published
 * package ships the suite's types but not its code (signalxjs/actors#491);
 * delete this copy and import `@sigx/actors/testing` once that lands.
 * Do not edit the cases here — fix them upstream.
 */
/**
 * The shapes every conformance suite in this repo is built from.
 *
 * No test framework is imported anywhere under `testing/`. A case is a
 * descriptor with a `run()` that throws on failure, so the same cases drive
 * from whatever runner a package uses — and so "what implementing this seam
 * means" is a readable list rather than an archaeology exercise across N
 * packages' test files.
 *
 * These subpaths are wired by tsconfig/vitest aliases only; they are
 * deliberately absent from `package.json` exports, so they cannot yet be
 * imported from outside this workspace.
 */

/** A case that could not run here, and why — reported, never silently passed. */
export interface ConformanceSkip {
    skipped: string;
}

export interface ConformanceCase<Factory> {
    readonly name: string;
    /** One line: what breaks in production when this case fails. */
    readonly why: string;
    run(create: Factory): Promise<void | ConformanceSkip>;
}
