/**
 * Which CI lanes a change set needs (#fast-lane). Pure: paths in, flags out,
 * so `.github/workflows/ci.yml` skips what a PR cannot break. Anything this
 * does not recognise runs everything — a wrong "skip" is the only real risk.
 */

/** Paths that change nothing a check can see. */
const DOCS = [/^docs\//, /^[^/]+\.md$/, /\/README\.md$/, /^\.github\/ISSUE_TEMPLATE\//, /^\.github\/pull_request_template\.md$/, /^\.github\/copilot-instructions\.md$/, /^\.claude\//, /^LICENSE$/];

/** Paths that can change every lane: config, the lockfile, the workflows. */
const EVERYTHING = [/^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^package\.json$/, /^tsconfig[^/]*\.json$/, /^vitest\.config\.ts$/, /^\.oxlintrc/, /^\.github\/workflows\//, /^\.size-limit\.json$/];

const LANES = {
    // Worker + ActorHost DO inside workerd, and the acceptance suite.
    workers: [/^apps\/web\//, /^packages\/(core|platform|runtimes|memory|learning|connectors|plugins-git|mcp|a2a|daemon-protocol)\//],
    // Playwright against the app: the app, the UI it renders, the data under it.
    e2e: [/^apps\/web\//, /^packages\/(ui|core|platform)\//],
    // .size-limit.json entries.
    size: [/^packages\/(core|ui|connectors|plugins-git)\//],
    scripts: [/^scripts\//]
};

/**
 * @param {readonly string[]} files repo-relative, forward slashes
 * @returns {{ code: boolean, workers: boolean, e2e: boolean, size: boolean, scripts: boolean }}
 */
export function lanesFor(files) {
    const paths = files.map((f) => f.replaceAll('\\', '/')).filter(Boolean);
    const all = { code: true, workers: true, e2e: true, size: true, scripts: true };
    if (paths.some((p) => EVERYTHING.some((re) => re.test(p)))) return all;
    const code = paths.filter((p) => !DOCS.some((re) => re.test(p)));
    const hit = (lane) => code.some((p) => LANES[lane].some((re) => re.test(p)));
    return { code: code.length > 0, workers: hit('workers'), e2e: hit('e2e'), size: hit('size'), scripts: hit('scripts') };
}
