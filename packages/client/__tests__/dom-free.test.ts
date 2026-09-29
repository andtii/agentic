/**
 * `@agentic/client` is DOM-free (#1116): the Lynx shell reuses it, so nothing in
 * `src/` may reach for `window`, `document` or `localStorage`, or import the
 * `sigx` umbrella or `@sigx/runtime-dom`. The oxlint override says the same; this
 * is the check that runs with the unit suite.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '../src');

const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

/** The code without its comments, so a doc comment may still name what the code must not touch. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FORBIDDEN_IMPORT = /^(sigx($|\/)|@sigx\/runtime-dom|@sigx\/zero|@sigx\/router|@agentic\/ui)/;

describe('@agentic/client is DOM-free (#1116)', () => {
    const sources = files(SRC).map((f) => ({ file: relative(SRC, f), text: code(readFileSync(f, 'utf8')) }));

    it('has sources to check', () => {
        expect(sources.length).toBeGreaterThan(0);
    });

    it('never touches window, document, localStorage or sessionStorage', () => {
        const hits = sources.flatMap(({ file, text }) => [...text.matchAll(/\b(window|document|localStorage|sessionStorage)\b/g)].map((m) => `${file}: ${m[1]}`));
        expect(hits).toEqual([]);
    });

    it('never imports the sigx umbrella, the DOM renderer, the router or the UI', () => {
        const hits = sources.flatMap(({ file, text }) =>
            [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
                .map((m) => m[1] ?? '')
                .filter((spec) => FORBIDDEN_IMPORT.test(spec))
                .map((spec) => `${file}: ${spec}`)
        );
        expect(hits).toEqual([]);
    });
});
