/**
 * The edge guard: this package runs on Workers and in the daemon alike, so
 * its sources may not import `node:` modules or touch `process` / `Buffer`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

/** Drop comments and string literals so prose and messages don't trip the scan. */
function codeOnly(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('@agentic/daemon-protocol edge safety', () => {
    it('sources import nothing from node: and never touch process or Buffer', () => {
        const offences: string[] = [];
        for (const file of walk(src)) {
            const raw = readFileSync(file, 'utf8');
            raw.split('\n').forEach((line, i) => {
                if (/from\s*['"]node:|import\(\s*['"]node:/.test(line)) offences.push(`${relative(root, file)}:${i + 1}: node: import`);
            });
            codeOnly(raw)
                .split('\n')
                .forEach((line, i) => {
                    if (/\brequire\s*\(/.test(line)) offences.push(`${relative(root, file)}:${i + 1}: require()`);
                    if (/\bprocess\b/.test(line)) offences.push(`${relative(root, file)}:${i + 1}: process global`);
                    if (/\bBuffer\b/.test(line)) offences.push(`${relative(root, file)}:${i + 1}: Buffer global`);
                });
        }
        expect(offences).toEqual([]);
    });
});
