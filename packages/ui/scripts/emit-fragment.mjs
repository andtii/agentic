// Emit the manifest fragment as JSON beside its JS form, so a design system
// without a build script of its own can adopt it through `--extra-manifest`
// (which takes a JSON file). Runs after `vite build`, from the built entry.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fragment } from '../dist/fragment.js';

const out = fileURLToPath(new URL('../dist/fragment.json', import.meta.url));
await writeFile(
    out,
    `${JSON.stringify(
        {
            $schema: 'https://signalxjs.github.io/zero/schemas/fragment.schema.json',
            ...fragment
        },
        null,
        4
    )}\n`
);
const n = fragment.components.length;
console.log(`[@agentic/ui] wrote dist/fragment.json (${n} component${n === 1 ? '' : 's'})`);
