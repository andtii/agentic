import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package is edge-safe by contract: no Node builtins, no `process`, no `Buffer`.
const src = join(import.meta.dirname, '..', 'src');
const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

describe('@agentic/core edge safety', () => {
    it('has source files', () => {
        expect(files.length).toBeGreaterThan(5);
    });
    it.each(files)('%s imports no node builtins and touches no process/Buffer', (file) => {
        const text = readFileSync(join(src, file), 'utf8');
        expect(text).not.toMatch(/from\s+['"]node:/);
        expect(text).not.toMatch(/\bprocess\.\w/);
        expect(text).not.toMatch(/\bBuffer\b/);
    });
    it('has no runtime dependencies', () => {
        const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
        expect(pkg.dependencies ?? {}).toEqual({});
        expect(pkg.peerDependencies ?? {}).toEqual({});
    });
});
