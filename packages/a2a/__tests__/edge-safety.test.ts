import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Edge-safe by contract: Web Streams and fetch only — no Node builtins, no `process`, no `Buffer`.
const src = join(import.meta.dirname, '..', 'src');
function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
}
const files = walk(src);

describe('@agentic/a2a edge safety', () => {
    it('has source files', () => {
        expect(files.length).toBeGreaterThan(10);
    });
    it.each(files.map((f) => f.slice(src.length + 1)))('%s imports no node builtins and touches no process/Buffer', (file) => {
        const text = readFileSync(join(src, file), 'utf8');
        expect(text).not.toMatch(/from\s+['"]node:/);
        expect(text).not.toMatch(/\bprocess\.\w/);
        expect(text).not.toMatch(/\bBuffer\b/);
    });
});
