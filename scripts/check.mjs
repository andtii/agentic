#!/usr/bin/env node
/**
 * `pnpm check [--base <ref>] [--workers] [--all]` — the local gate before the
 * one push (AGENTS.md). Runs what CI's PR lanes would run for this diff, minus
 * e2e: typecheck and lint always; the unit tests the change can reach
 * (`vitest --changed`); `pnpm build && pnpm size` when a size-limited package
 * changed; the scripts tests when `scripts/` changed; workerd with `--workers`.
 *
 * - `--base <ref>`: what to diff against (default `origin/main`; fetch first).
 * - `--all`: the whole unit suite instead of `--changed`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { lanesFor } from './lib/ci-changes.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'origin/main';
if (!base || base.startsWith('--')) {
    console.error('✗ --base needs a ref, e.g. pnpm check --base origin/main');
    process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
const files = [
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard')
];
const lanes = lanesFor(files);
console.log(`check: ${files.length} changed file(s) vs ${base} → ${Object.entries(lanes).filter(([, v]) => v).map(([k]) => k).join(', ') || 'docs only'}`);
if (!lanes.code) process.exit(0);

const steps = [
    ['typecheck', ['typecheck']],
    ['lint', ['lint']],
    ['unit', flag('--all') ? ['vitest', 'run', '--retry=1'] : ['vitest', 'run', '--retry=1', '--changed', base]]
];
if (lanes.scripts) steps.push(['scripts', ['test:scripts']]);
if (lanes.size || (flag('--workers') && lanes.workers)) steps.push(['build', ['build']]);
if (lanes.size) steps.push(['size', ['size']]);
if (flag('--workers') && lanes.workers) steps.push(['workers', ['--filter', '@agentic/web', 'test:workers']]);

for (const [name, args] of steps) {
    const started = Date.now();
    console.log(`\n── ${name}: pnpm ${args.join(' ')}`);
    const res = spawnSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) {
        console.error(`\n✗ check failed at ${name}`);
        process.exit(res.status ?? 1);
    }
    console.log(`✓ ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
}
console.log('\n✓ check passed — push once.');
