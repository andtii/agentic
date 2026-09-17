// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `packages/platform/src/auth` runs on Workers: no Node builtins, no `process`, no `Buffer`.
const root = join(import.meta.dirname, '..', '..', 'src', 'auth');

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : name.endsWith('.ts') ? [full] : [];
    });
}

const files = walk(root).map((f) => f.slice(root.length + 1));

describe('@agentic/platform auth edge safety', () => {
    it('has source files', () => {
        expect(files.length).toBeGreaterThan(8);
    });
    it.each(files)('%s imports no node builtins and touches no process/Buffer', (file) => {
        const text = readFileSync(join(root, file), 'utf8');
        expect(text).not.toMatch(/from\s+['"]node:/);
        expect(text).not.toMatch(/\bprocess\.\w/);
        expect(text).not.toMatch(/\bBuffer\b/);
        // secrets are values passed in, never read from the environment here
        expect(text).not.toMatch(/\benv\.[A-Z_]+/);
    });
});
