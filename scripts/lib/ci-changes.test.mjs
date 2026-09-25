import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanesFor } from './ci-changes.mjs';

const none = { code: false, workers: false, e2e: false, size: false, scripts: false };

test('docs-only changes need no lane', () => {
    assert.deepEqual(lanesFor(['docs/architecture.md', 'AGENTS.md', 'packages/ui/README.md', '.claude/skills/take-issue/SKILL.md']), none);
    assert.deepEqual(lanesFor([]), none);
});

test('config, lockfile and workflow changes run every lane', () => {
    for (const f of ['pnpm-lock.yaml', 'package.json', 'tsconfig.json', 'vitest.config.ts', '.github/workflows/ci.yml', '.size-limit.json']) {
        assert.deepEqual(lanesFor([f]), { code: true, workers: true, e2e: true, size: true, scripts: true }, f);
    }
});

test('a web page change runs workers and e2e, not size', () => {
    assert.deepEqual(lanesFor(['apps/web/src/pages/Projects.tsx']), { ...none, code: true, workers: true, e2e: true });
});

test('a ui change runs e2e and size, not workers', () => {
    assert.deepEqual(lanesFor(['packages/ui/src/kit/Tag.tsx']), { ...none, code: true, e2e: true, size: true });
});

test('a platform change runs workers and e2e', () => {
    assert.deepEqual(lanesFor(['packages/platform/src/plan/actor.ts']), { ...none, code: true, workers: true, e2e: true });
});

test('a daemon change runs only the unit lane', () => {
    assert.deepEqual(lanesFor(['apps/daemon/src/fs.ts']), { ...none, code: true });
});

test('a scripts change runs the scripts lane', () => {
    assert.deepEqual(lanesFor(['scripts/worktree.mjs']), { ...none, code: true, scripts: true });
});

test('windows separators are accepted', () => {
    assert.deepEqual(lanesFor(['packages\\core\\src\\ids.ts']).size, true);
});
