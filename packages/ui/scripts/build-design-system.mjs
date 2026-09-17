// Compile the design system: validate → compile → report → write, through
// the kit's standard pipeline, against zero's anatomy manifest with this
// package's own fragment merged in. Runs after `vite build`, from the built
// entries, so the same modules the app imports are the ones compiled.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runStandardBuild } from '@sigx/zero-kit/build';

const require = createRequire(import.meta.url);
const manifest = require('@sigx/zero/manifest.json');
const { designSystem } = await import('../dist/design-system.js');
const { fragment } = await import('../dist/fragment.js');

const outDir = fileURLToPath(new URL('../dist/ds/', import.meta.url));
const { result, written } = await runStandardBuild({ designSystem, manifest, fragments: [fragment], outDir });
console.log(`[@agentic/ui] design system "${designSystem.name}": ${result.errors.length} errors, ${result.warnings.length} warnings, ${written.length} artifacts in dist/ds`);
