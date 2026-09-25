#!/usr/bin/env node
/**
 * `node scripts/ci-changes.mjs [<base-ref>]` — prints the CI lanes a change
 * needs as `key=value` lines (append to $GITHUB_OUTPUT in CI).
 *
 * - No argument in a PR checkout (a merge commit): diffs HEAD^1..HEAD, i.e. the
 *   PR against its base. Needs `fetch-depth: 2`.
 * - `ALL=1` in the environment (push to main, nightly): every lane on.
 * - With a ref (locally): diffs `<ref>...HEAD` plus the working tree and untracked files.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { lanesFor } from './lib/ci-changes.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);

let lanes;
if (process.env.ALL === '1') {
    lanes = lanesFor(['package.json']);
} else {
    const base = process.argv[2];
    const files = base
        ? [...git('diff', '--name-only', `${base}...HEAD`), ...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')]
        : git('diff', '--name-only', 'HEAD^1', 'HEAD');
    lanes = lanesFor(files);
}
const out = Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
process.stdout.write(out);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
